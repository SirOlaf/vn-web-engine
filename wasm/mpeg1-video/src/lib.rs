#![no_std]

//! MPEG-1 video elementary-stream decoder mirroring `src/formats/mpeg1/reference.ts`.
//! One instance decodes one stream; its state lives in statics.

mod bits;
mod idct;
mod predict;

use bits::{Bits, Vlc};
use core::arch::wasm32::{memory_grow, memory_size};
use core::ptr::{addr_of, addr_of_mut, null_mut};
use idct::Block;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// Called for each output picture; the host copies its planes before returning.
    fn mpeg1_emit(y: usize, cb: usize, cr: usize, index: u32, kind: u32, temporal: u32);
}

/// Largest input section the host may stage, as in the reference decoder.
const PENDING_LIMIT: usize = 16 * 1024 * 1024;
/// Readable bytes after the pending input for the bit reader's cache.
const PENDING_SLACK: usize = 64;
const VLC_CAPACITY: usize = 16384;
const PICTURES_PER_CALL: u32 = 32;

// Failure codes, mirrored by `src/formats/mpeg1/wasm-decoder.ts`.
pub const FAIL_RANGE: u32 = 1;
pub const FAIL_VLC: u32 = 2;
const FAIL_SEQUENCE: u32 = 3;
const FAIL_RESOLUTION: u32 = 4;
const FAIL_MARKER: u32 = 5;
const FAIL_MATRIX: u32 = 6;
const FAIL_NO_SEQUENCE: u32 = 7;
const FAIL_PICTURE_TYPE: u32 = 8;
const FAIL_FCODE: u32 = 9;
const FAIL_NO_PICTURE: u32 = 10;
const FAIL_IDCPREC: u32 = 11;
const FAIL_START_CODE: u32 = 12;
const FAIL_SLICE_QUANT: u32 = 13;
const FAIL_ADDRESS: u32 = 14;
const FAIL_SKIPPED_INTRA: u32 = 15;
const FAIL_SKIPPED_B: u32 = 16;
const FAIL_MACROBLOCK_QUANT: u32 = 17;
const FAIL_OVERLAP: u32 = 18;
const FAIL_REFERENCE: u32 = 19;
const FAIL_NO_PREDICTION: u32 = 20;
const FAIL_EMPTY_BLOCK: u32 = 21;
const FAIL_ESCAPE: u32 = 22;
const FAIL_RUN: u32 = 23;
const FAIL_INCOMPLETE: u32 = 24;
const FAIL_TOO_MANY: u32 = 25;
const FAIL_MISSING_START: u32 = 26;
const FAIL_TRUNCATED_START: u32 = 27;
const FAIL_MEMORY: u32 = 28;

// Host table order.
const AC: usize = 0;
const ADDRESS: usize = 1;
const CBP: usize = 2;
const MOTION: usize = 3;
const DC_Y: usize = 4;
const DC_C: usize = 5;
const TYPE_I: usize = 6;

const ZIGZAG: [u8; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const INTRA: [u8; 64] = [
    8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38,
    22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58,
    26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
];

/// The reference's error and, for slice errors, the context its message names.
#[repr(C)]
pub struct Failure {
    code: u32,
    a: i32,
    b: i32,
    c: i32,
    in_slice: u32,
    temporal: u32,
    kind: u32,
    slice: u32,
    address: i32,
    bit: u32,
}

/// `has`, width, height, aspect code and frame-rate code of the last sequence header.
#[repr(C)]
pub struct Sequence {
    has: u32,
    width: u32,
    height: u32,
    aspect: u32,
    rate: u32,
}

pub struct Fail;
pub type R<T = ()> = Result<T, Fail>;

#[cold]
pub fn fail<T>(code: u32, a: i32, b: i32, c: i32) -> R<T> {
    unsafe {
        *addr_of_mut!(FAILURE) = Failure {
            code,
            a,
            b,
            c,
            in_slice: 0,
            temporal: 0,
            kind: 0,
            slice: 0,
            address: 0,
            bit: 0,
        };
    }
    Err(Fail)
}

const NONE: usize = usize::MAX;

struct Decoder {
    tables: [Vlc; 9],
    pending: *mut u8,
    pending_len: usize,
    /// The next input position the start-code scan has not examined.
    scan: usize,
    /// The pending input begins with a start code.
    has_start: bool,
    stride: usize,
    padded_height: usize,
    mb_width: usize,
    mb_count: usize,
    luma: usize,
    /// Three picture buffers (Y, Cb, Cr contiguous) and their header fields.
    slots: [*mut u8; 3],
    kinds: [u32; 3],
    temporals: [u32; 3],
    current: usize,
    past: usize,
    future: usize,
    covered: *mut u8,
    decoded: usize,
    output_index: u32,
    emitted: u32,
    intra_matrix: [u8; 64],
    inter_matrix: [u8; 64],
    dc: [i64; 3],
    motion: [i32; 4],
    fcode: [u32; 2],
    fullpel: [u32; 2],
    dc_precision: u32,
    quant: u32,
    address: i32,
    last_type: u32,
    block: Block,
}

static mut FAILURE: Failure = Failure {
    code: 0,
    a: 0,
    b: 0,
    c: 0,
    in_slice: 0,
    temporal: 0,
    kind: 0,
    slice: 0,
    address: 0,
    bit: 0,
};
static mut SEQUENCE: Sequence = Sequence {
    has: 0,
    width: 0,
    height: 0,
    aspect: 0,
    rate: 0,
};
static mut VLC_INDEX: [u32; 27] = [0; 27];
static mut VLC_DATA: [u32; VLC_CAPACITY] = [0; VLC_CAPACITY];
static mut DECODER: Decoder = Decoder {
    tables: [Vlc::EMPTY; 9],
    pending: null_mut(),
    pending_len: 0,
    scan: 0,
    has_start: false,
    stride: 0,
    padded_height: 0,
    mb_width: 0,
    mb_count: 0,
    luma: 0,
    slots: [null_mut(); 3],
    kinds: [0; 3],
    temporals: [0; 3],
    current: NONE,
    past: NONE,
    future: NONE,
    covered: null_mut(),
    decoded: 0,
    output_index: 0,
    emitted: 0,
    intra_matrix: INTRA,
    inter_matrix: [16; 64],
    dc: [128; 3],
    motion: [0; 4],
    fcode: [0; 2],
    fullpel: [0; 2],
    dc_precision: 0,
    quant: 0,
    address: -1,
    last_type: 0,
    block: Block {
        coeff: [0.0; 64],
        columns: 0,
        last: [0; 8],
    },
};

#[inline(always)]
unsafe fn decoder() -> &'static mut Decoder {
    &mut *addr_of_mut!(DECODER)
}

/// Bump allocation past the instance's initial memory, which holds the stack and statics.
unsafe fn allocate(bytes: usize) -> R<*mut u8> {
    let start = memory_size(0) * 65536;
    if memory_grow(0, bytes.div_ceil(65536)) == usize::MAX {
        return fail(FAIL_MEMORY, 0, 0, 0);
    }
    Ok(start as *mut u8)
}

#[no_mangle]
pub unsafe extern "C" fn vlc_index() -> *mut u32 {
    addr_of_mut!(VLC_INDEX) as *mut u32
}

#[no_mangle]
pub unsafe extern "C" fn vlc_data() -> *mut u32 {
    addr_of_mut!(VLC_DATA) as *mut u32
}

#[no_mangle]
pub extern "C" fn vlc_capacity() -> usize {
    VLC_CAPACITY
}

#[no_mangle]
pub unsafe extern "C" fn basis() -> *mut f64 {
    addr_of_mut!(idct::BASIS) as *mut f64
}

#[no_mangle]
pub unsafe extern "C" fn failure() -> *const Failure {
    addr_of!(FAILURE)
}

#[no_mangle]
pub unsafe extern "C" fn sequence() -> *const Sequence {
    addr_of!(SEQUENCE)
}

/// Binds the host-written tables and reserves the input buffer. Nonzero on failure.
#[no_mangle]
pub unsafe extern "C" fn init() -> i32 {
    let d = decoder();
    let index = &*addr_of!(VLC_INDEX);
    let data = addr_of!(VLC_DATA) as *const u32;
    for (table, vlc) in d.tables.iter_mut().enumerate() {
        *vlc = Vlc {
            lookup: data.add(index[table * 3] as usize),
            primary: index[table * 3 + 1],
            tree: data.add(index[table * 3 + 2] as usize),
        };
    }
    match allocate(PENDING_LIMIT + PENDING_SLACK) {
        Ok(pending) => {
            d.pending = pending;
            0
        }
        Err(_) => 1,
    }
}

/// Where the host appends input after the pending section.
#[no_mangle]
pub unsafe extern "C" fn pending_end() -> *mut u8 {
    let d = decoder();
    d.pending.add(d.pending_len)
}

#[no_mangle]
pub unsafe extern "C" fn pending_length() -> usize {
    decoder().pending_len
}

/// Decodes the sections completed by `length` bytes appended at `pending_end`. Nonzero on failure.
#[no_mangle]
pub unsafe extern "C" fn push(length: usize) -> i32 {
    let d = decoder();
    d.emitted = 0;
    let len = d.pending_len + length;
    let input = d.pending;
    let mut start = if d.has_start { 0 } else { NONE };
    let mut i = d.scan;
    while i + 3 < len {
        // No start code begins at i, i + 1 or i + 2 unless byte i + 2 is 0 or 1.
        if *input.add(i + 2) > 1 {
            i += 3;
            continue;
        }
        if *input.add(i) != 0 || *input.add(i + 1) != 0 || *input.add(i + 2) != 1 {
            i += 1;
            continue;
        }
        if start != NONE {
            if section(*input.add(start + 3) as u32, start + 4, i).is_err() {
                return 1;
            }
        } else if i != 0 && (0..i).any(|j| *input.add(j) != 0) {
            fail::<()>(FAIL_MISSING_START, 0, 0, 0).ok();
            return 1;
        }
        start = i;
        i += 3;
    }
    if start == NONE {
        d.pending_len = len;
        d.scan = i;
    } else {
        core::ptr::copy(input.add(start), input, len - start);
        d.pending_len = len - start;
        d.scan = i - start;
        d.has_start = true;
    }
    0
}

/// Decodes the final section and emits the delayed reference. Nonzero on failure.
#[no_mangle]
pub unsafe extern "C" fn flush() -> i32 {
    let d = decoder();
    d.emitted = 0;
    let p = d.pending;
    let result = (|| {
        if d.pending_len >= 4 && *p == 0 && *p.add(1) == 0 && *p.add(2) == 1 {
            section(*p.add(3) as u32, 4, d.pending_len)?;
        } else if d.pending_len != 0 {
            return fail(FAIL_TRUNCATED_START, 0, 0, 0);
        }
        finish_picture()?;
        if d.future != NONE {
            emit(d.future)?;
            d.future = NONE;
        }
        d.pending_len = 0;
        Ok(())
    })();
    result.is_err() as i32
}

unsafe fn emit(slot: usize) -> R {
    let d = decoder();
    if d.emitted >= PICTURES_PER_CALL {
        return fail(FAIL_TOO_MANY, 0, 0, 0);
    }
    d.emitted += 1;
    let index = d.output_index;
    d.output_index += 1;
    let y = d.slots[slot] as usize;
    mpeg1_emit(
        y,
        y + d.luma,
        y + d.luma + d.luma / 4,
        index,
        d.kinds[slot],
        d.temporals[slot],
    );
    Ok(())
}

unsafe fn finish_picture() -> R {
    let d = decoder();
    let slot = d.current;
    if slot == NONE {
        return Ok(());
    }
    if d.decoded != d.mb_count {
        return fail(FAIL_INCOMPLETE, 0, 0, 0);
    }
    if d.kinds[slot] == 3 {
        emit(slot)?;
    } else {
        if d.future != NONE {
            emit(d.future)?;
        }
        d.past = d.future;
        d.future = slot;
    }
    d.current = NONE;
    Ok(())
}

unsafe fn section(code: u32, start: usize, end: usize) -> R {
    let d = decoder();
    let data = d.pending.add(start);
    // A start code may begin inside the previous one's code byte, leaving an empty section.
    let length = end.saturating_sub(start);
    let mut bits = Bits::new(data, length);
    match code {
        0xb3 => sequence_header(&mut bits),
        0 => picture_header(&mut bits),
        1..=0xaf => {
            if d.current == NONE {
                return fail(FAIL_NO_PICTURE, 0, 0, 0);
            }
            let result = slice(code, &mut bits);
            if result.is_err() {
                let f = &mut *addr_of_mut!(FAILURE);
                f.in_slice = 1;
                f.temporal = d.temporals[d.current];
                f.kind = d.kinds[d.current];
                f.slice = code;
                f.address = d.address;
                f.bit = bits.pos as u32;
            }
            result
        }
        0xb8 => {
            finish_picture()?;
            bits.skip(27)
        }
        0xb7 => {
            finish_picture()?;
            if d.future != NONE {
                emit(d.future)?;
                d.future = NONE;
            }
            d.past = NONE;
            Ok(())
        }
        0xb2 => user_data(core::slice::from_raw_parts(data, length)),
        _ => fail(FAIL_START_CODE, code as i32, 0, 0),
    }
}

/// Native 1401830b0: IDCPREC zero selects 8 bits; nonzero selects 11 bits.
fn user_data(bytes: &[u8]) -> R {
    const MARKER: &[u8] = b"IDCPREC\0";
    let Some(marker) = bytes.windows(MARKER.len()).position(|w| w == MARKER) else {
        return Ok(());
    };
    let field = |at: usize| bytes.get(marker + at..marker + at + 8);
    let value = field(16);
    match (field(8), value) {
        (Some(b"00000008"), Some(&[b'0', b'0', b'0', b'0', b'0', b'0', b'0', digit]))
            if (b'0'..=b'3').contains(&digit) =>
        {
            unsafe { decoder().dc_precision = if digit == b'0' { 0 } else { 3 } };
            Ok(())
        }
        _ => fail(FAIL_IDCPREC, 0, 0, 0),
    }
}

unsafe fn sequence_header(bits: &mut Bits) -> R {
    finish_picture()?;
    let d = decoder();
    let s = &mut *addr_of_mut!(SEQUENCE);
    let width = bits.read(12)?;
    let height = bits.read(12)?;
    let aspect = bits.read(4)?;
    let rate = bits.read(4)?;
    if width == 0
        || height == 0
        || width > 4096
        || height > 2160
        || !(1..=8).contains(&rate)
        || aspect == 0
        || aspect == 15
    {
        return fail(FAIL_SEQUENCE, 0, 0, 0);
    }
    if s.has != 0 && (width != s.width || height != s.height) {
        return fail(FAIL_RESOLUTION, 0, 0, 0);
    }
    *s = Sequence {
        has: 1,
        width,
        height,
        aspect,
        rate,
    };
    if d.slots[0].is_null() {
        let stride = (width as usize).div_ceil(16) * 16;
        let padded_height = (height as usize).div_ceil(16) * 16;
        d.stride = stride;
        d.padded_height = padded_height;
        d.mb_width = stride / 16;
        d.mb_count = stride * padded_height / 256;
        d.luma = stride * padded_height;
        // Plane reads stay inside the picture; 16 bytes of slack cover a final 8-byte row load.
        let picture = d.luma + d.luma / 2 + 16;
        let memory = allocate(picture * 3 + d.mb_count)?;
        for (slot, buffer) in d.slots.iter_mut().enumerate() {
            *buffer = memory.add(slot * picture);
        }
        d.covered = memory.add(picture * 3);
    }
    bits.skip(18)?;
    if bits.read(1)? != 1 {
        return fail(FAIL_MARKER, 0, 0, 0);
    }
    bits.skip(11)?;
    d.intra_matrix = INTRA;
    d.inter_matrix = [16; 64];
    for matrix in [&mut d.intra_matrix, &mut d.inter_matrix] {
        if bits.read(1)? != 0 {
            for &position in ZIGZAG.iter() {
                let value = bits.read(8)?;
                if value == 0 {
                    return fail(FAIL_MATRIX, 0, 0, 0);
                }
                matrix[position as usize] = value as u8;
            }
        }
    }
    Ok(())
}

unsafe fn picture_header(bits: &mut Bits) -> R {
    finish_picture()?;
    let d = decoder();
    if (*addr_of!(SEQUENCE)).has == 0 {
        return fail(FAIL_NO_SEQUENCE, 0, 0, 0);
    }
    let temporal = bits.read(10)?;
    let kind = bits.read(3)?;
    bits.skip(16)?;
    if !(1..=3).contains(&kind) {
        return fail(FAIL_PICTURE_TYPE, kind as i32, 0, 0);
    }
    for direction in 0..2 {
        if kind >= direction as u32 + 2 {
            d.fullpel[direction] = bits.read(1)?;
            d.fcode[direction] = bits.read(3)?;
            if d.fcode[direction] == 0 {
                return fail(FAIL_FCODE, 0, 0, 0);
            }
        }
    }
    while bits.read(1)? != 0 {
        bits.skip(8)?;
    }
    let slot = (0..3).find(|&s| s != d.past && s != d.future).unwrap_or(0);
    d.current = slot;
    d.kinds[slot] = kind;
    d.temporals[slot] = temporal;
    d.decoded = 0;
    core::ptr::write_bytes(d.covered, 0, d.mb_count);
    Ok(())
}

unsafe fn slice(code: u32, bits: &mut Bits) -> R {
    let d = decoder();
    let kind = d.kinds[d.current];
    let max_address = d.mb_count as i32;
    d.quant = bits.read(5)?;
    if d.quant == 0 {
        return fail(FAIL_SLICE_QUANT, 0, 0, 0);
    }
    while bits.read(1)? != 0 {
        bits.skip(8)?;
    }
    let dc_reset = 128i64 << d.dc_precision;
    d.dc = [dc_reset; 3];
    d.motion = [0; 4];
    d.address = (code as i32 - 1) * d.mb_width as i32 - 1;
    d.last_type = 0;
    let mut first = true;
    let address_vlc = d.tables[ADDRESS];
    let type_vlc = d.tables[TYPE_I + kind as usize - 1];
    while bits.len - bits.pos >= 1 {
        // Macroblocks continue until 23 zero bits (ISO/IEC 11172-2 2.4.2.6).
        let left = bits.len - bits.pos;
        if bits.peek(left.min(23) as u32)? == 0 {
            bits.skip(left)?;
            break;
        }
        let mut increment = 0i32;
        let mut value;
        loop {
            value = address_vlc.read(bits)?;
            if value == 34 {
                increment += 33;
            }
            if value < 34 {
                break;
            }
        }
        increment += value;
        if d.address + increment >= max_address {
            return fail(FAIL_ADDRESS, 0, 0, 0);
        }
        if !first && increment > 1 {
            d.dc = [dc_reset; 3];
            for _ in 1..increment {
                d.address += 1;
                if kind == 1 {
                    return fail(FAIL_SKIPPED_INTRA, 0, 0, 0);
                }
                if kind == 2 {
                    d.motion = [0; 4];
                    predict(8)?;
                } else {
                    if d.last_type & 12 == 0 || d.last_type & 1 != 0 {
                        return fail(FAIL_SKIPPED_B, 0, 0, 0);
                    }
                    predict(d.last_type)?;
                }
                mark_macroblock()?;
            }
            d.address += 1;
        } else {
            d.address += increment;
        }
        first = false;
        let mb_type = type_vlc.read(bits)? as u32;
        d.last_type = mb_type;
        if mb_type & 16 != 0 {
            d.quant = bits.read(5)?;
            if d.quant == 0 {
                return fail(FAIL_MACROBLOCK_QUANT, 0, 0, 0);
            }
        }
        let intra = mb_type & 1 != 0;
        if intra {
            d.motion = [0; 4];
        } else {
            d.dc = [dc_reset; 3];
            for direction in 0..2 {
                if mb_type & (8 >> direction) != 0 {
                    for axis in 0..2 {
                        decode_motion(bits, direction, axis)?;
                    }
                } else if kind == 2 && direction == 0 {
                    d.motion[0] = 0;
                    d.motion[1] = 0;
                }
            }
            predict(if kind == 2 { mb_type | 8 } else { mb_type })?;
        }
        let pattern = if mb_type & 2 != 0 {
            d.tables[CBP].read(bits)? as u32
        } else if intra {
            63
        } else {
            0
        };
        for block in 0..6 {
            if pattern & (32 >> block) != 0 {
                decode_block(bits, block, intra)?;
            }
        }
        mark_macroblock()?;
    }
    Ok(())
}

unsafe fn mark_macroblock() -> R {
    let d = decoder();
    let address = d.address;
    if address < 0 || address as usize >= d.mb_count || *d.covered.add(address as usize) != 0 {
        return fail(FAIL_OVERLAP, 0, 0, 0);
    }
    *d.covered.add(address as usize) = 1;
    d.decoded += 1;
    Ok(())
}

unsafe fn decode_motion(bits: &mut Bits, direction: usize, axis: usize) -> R {
    let d = decoder();
    let code = d.tables[MOTION].read(bits)?;
    let r = d.fcode[direction] - 1;
    let scale = 1i32 << r;
    let i = direction * 2 + axis;
    let mut delta = 0;
    if code != 0 {
        delta = (code.abs() - 1) * scale + bits.read(r)? as i32 + 1;
        if code < 0 {
            delta = -delta;
        }
    }
    let mut value = d.motion[i] + delta;
    let limit = 16 * scale;
    if value < -limit {
        value += 2 * limit;
    } else if value >= limit {
        value -= 2 * limit;
    }
    d.motion[i] = value;
    Ok(())
}

unsafe fn predict(mb_type: u32) -> R {
    let d = decoder();
    let kind = d.kinds[d.current];
    let target = d.slots[d.current];
    let mut average = false;
    for direction in 0..2 {
        if mb_type & (8 >> direction) == 0 {
            continue;
        }
        let reference = if direction == 1 || kind == 2 {
            d.future
        } else {
            d.past
        };
        if reference == NONE {
            return fail(FAIL_REFERENCE, 0, 0, 0);
        }
        let source = d.slots[reference];
        let mx = d.motion[direction * 2] * (1 << d.fullpel[direction]);
        let my = d.motion[direction * 2 + 1] * (1 << d.fullpel[direction]);
        let mb_x = d.address as usize % d.mb_width;
        let mb_y = d.address as usize / d.mb_width;
        for plane in 0..3 {
            let (stride, height, size, offset) = if plane == 0 {
                (d.stride, d.padded_height, 16, 0)
            } else {
                let chroma = d.luma / 4;
                (
                    d.stride / 2,
                    d.padded_height / 2,
                    8,
                    d.luma + (plane - 1) * chroma,
                )
            };
            let (dx, dy) = if plane == 0 {
                (mx, my)
            } else {
                (mx / 2, my / 2)
            };
            let (ix, iy) = (dx >> 1, dy >> 1);
            let (hx, hy) = (dx & 1 != 0, dy & 1 != 0);
            let x0 = (mb_x * size) as i32;
            let y0 = (mb_y * size) as i32;
            let src = source.add(offset);
            let dst = target.add(offset);
            if x0 + ix >= 0
                && y0 + iy >= 0
                && x0 + ix + size as i32 + hx as i32 <= stride as i32
                && y0 + iy + size as i32 + hy as i32 <= height as i32
            {
                predict::inside(
                    src.add(((y0 + iy) as usize) * stride + (x0 + ix) as usize),
                    dst.add(y0 as usize * stride + x0 as usize),
                    stride,
                    hx,
                    hy,
                    size,
                    average,
                );
            } else {
                predict::clamped(
                    src,
                    dst,
                    stride as i32,
                    height as i32,
                    x0,
                    y0,
                    ix,
                    iy,
                    hx,
                    hy,
                    size as i32,
                    average,
                );
            }
        }
        average = true;
    }
    if !average {
        return fail(FAIL_NO_PREDICTION, 0, 0, 0);
    }
    Ok(())
}

unsafe fn decode_block(bits: &mut Bits, block: usize, intra: bool) -> R {
    let d = decoder();
    let b = &mut d.block;
    let mut n = 0usize;
    if intra {
        let component = if block < 4 { 0 } else { block - 3 };
        let size = d.tables[if component == 0 { DC_Y } else { DC_C }].read(bits)? as u32;
        let raw = bits.read(size)? as i64;
        let delta = if size != 0 && raw < 1 << (size - 1) {
            raw - ((1 << size) - 1)
        } else {
            raw
        };
        d.dc[component] += delta;
        b.coeff[0] = (d.dc[component] * (1 << (3 - d.dc_precision))) as f64;
        b.columns = 1;
        n = 1;
    }
    let matrix = if intra {
        &d.intra_matrix
    } else {
        &d.inter_matrix
    };
    let quant = d.quant as i32;
    let ac = d.tables[AC];
    loop {
        let code = if !intra && n == 0 && bits.peek(1)? != 0 {
            bits.consume(1);
            1
        } else {
            ac.read(bits)?
        };
        if code == -1 {
            if n == 0 {
                return fail(FAIL_EMPTY_BLOCK, 0, 0, 0);
            }
            break;
        }
        let run;
        let mut level;
        if code == -2 {
            run = bits.read(6)? as usize;
            level = bits.read(8)? as i32;
            if level == 0 {
                level = bits.read(8)? as i32;
            } else if level == 128 {
                level = bits.read(8)? as i32 - 256;
            } else if level > 128 {
                level -= 256;
            }
            if level == 0 {
                return fail(FAIL_ESCAPE, 0, 0, 0);
            }
        } else {
            run = (code >> 8) as usize;
            level = code & 255;
            if bits.read(1)? != 0 {
                level = -level;
            }
        }
        n += run;
        if n >= 64 {
            return fail(FAIL_RUN, 0, 0, 0);
        }
        let index = ZIGZAG[n] as usize;
        n += 1;
        let magnitude = level.abs();
        let m = matrix[index] as i32;
        let mut value = if intra {
            magnitude * m * quant / 8
        } else {
            (2 * magnitude + 1) * m * quant / 16
        };
        if value != 0 && value & 1 == 0 {
            value -= 1;
        }
        let value = if level < 0 { -value } else { value };
        b.coeff[index] = value.clamp(-2048, 2047) as f64;
        let (u, v) = (index & 7, (index >> 3) as u8);
        b.columns |= 1 << u;
        if v > b.last[u] {
            b.last[u] = v;
        }
    }
    let mb_x = d.address as usize % d.mb_width;
    let mb_y = d.address as usize / d.mb_width;
    let slot = d.slots[d.current];
    let (stride, dest) = if block < 4 {
        (
            d.stride,
            slot.add((mb_y * 16 + (block >> 1) * 8) * d.stride + mb_x * 16 + (block & 1) * 8),
        )
    } else {
        let stride = d.stride / 2;
        (
            stride,
            slot.add(d.luma + (block - 4) * (d.luma / 4) + mb_y * 8 * stride + mb_x * 8),
        )
    };
    idct::add(b, dest, stride, intra);
    Ok(())
}
