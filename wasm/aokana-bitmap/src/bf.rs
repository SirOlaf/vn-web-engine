//! BF movie frames (native 140105f30 with its alpha and color row workers).
//! Mirrors `src/engines/buriko/native/bf-frame.ts`, which stays the reference:
//! every condition where it would raise returns a nonzero status, and the host
//! reruns the TypeScript decoder on the untouched surface to raise the exact
//! native error. The work items run in native order: alpha first, then the rows.
//! Nonzero from either step means the host must run the reference decoder on its
//! own, unmodified surface.
//! A row only reads and writes coefficient storage inside its own region, so its
//! result does not depend on how the native pool interleaves rows; any other
//! access also returns to the reference.

use core::arch::wasm32::*;
use core::ptr::read_unaligned;

const BF_OK: i32 = 0;
const BF_FAIL: i32 = 1;
/// Lookup entries are `(length << 24) | node`; this marks an unwritten entry.
const UNDEFINED: u32 = u32::MAX;

const ZIGZAG: [u8; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// AAN scale products as binary32 values (native table 0x1401647a0, movie-idct.ts).
const AAN_SCALE: [f32; 64] = [
    1.0,
    1.3870398998260498,
    1.3065630197525024,
    1.1758755445480347,
    1.0,
    0.78569495677948,
    0.5411961078643799,
    0.27589938044548035,
    1.3870398998260498,
    1.9238795042037964,
    1.8122549057006836,
    1.6309863328933716,
    1.3870398998260498,
    1.0897902250289917,
    0.7506605386734009,
    0.3826834261417389,
    1.3065630197525024,
    1.8122549057006836,
    1.7071068286895752,
    1.5363554954528809,
    1.3065630197525024,
    1.0265599489212036,
    0.7071067690849304,
    0.3604799211025238,
    1.1758755445480347,
    1.6309863328933716,
    1.5363554954528809,
    1.3826833963394165,
    1.1758755445480347,
    0.9238795042037964,
    0.6363793015480042,
    0.32442334294319153,
    1.0,
    1.3870398998260498,
    1.3065630197525024,
    1.1758755445480347,
    1.0,
    0.78569495677948,
    0.5411961078643799,
    0.27589938044548035,
    0.78569495677948,
    1.0897902250289917,
    1.0265599489212036,
    0.9238795042037964,
    0.78569495677948,
    0.6173165440559387,
    0.4252150356769562,
    0.21677275002002716,
    0.5411961078643799,
    0.7506605386734009,
    0.7071067690849304,
    0.6363793015480042,
    0.5411961078643799,
    0.4252150356769562,
    0.2928932309150696,
    0.14931567013263702,
    0.27589938044548035,
    0.3826834261417389,
    0.3604799211025238,
    0.32442334294319153,
    0.27589938044548035,
    0.21677275002002716,
    0.14931567013263702,
    0.07612046599388123,
];

/// The host's parameter block, one u32 per field.
#[repr(C)]
pub struct BfFrame {
    frame: *const u8,
    frame_length: u32,
    width: u32,
    height: u32,
    depth: u32,
    /// 0 for frames without alpha (depth != 32), else the validated codec 1 or 2.
    alpha_mode: u32,
    alpha_start: u32,
    /// Codec 2: offset of the symbol bits after the size and weights.
    alpha_bits_start: u32,
    surface: *mut u8,
    surface_length: u32,
    /// Null when every surface byte is initialized.
    initialized: *mut u8,
    frame_extent: u32,
    coefficients: *mut i16,
    defined: *mut u8,
    coefficient_count: u32,
    /// Per row: start, count, data start, limit.
    descriptors: *const u32,
    rows: u32,
    columns: u32,
    aligned_width: u32,
    /// Trees: leaves, capacity, 256 lookup entries, capacity child pairs.
    dc_tree: *const u32,
    ac_tree: *const u32,
    alpha_tree: *const u32,
    quantization: *const u8,
    color_table: *const f32,
    decoded: *mut u8,
    decoded_length: u32,
}

struct Bits {
    bytes: *const u8,
    length: usize,
    position: usize,
}

impl Bits {
    unsafe fn new(frame: &BfFrame, start: usize) -> Bits {
        let length = frame.frame_length as usize;
        let start = start.min(length);
        Bits {
            bytes: frame.frame.add(start),
            length: length - start,
            position: 0,
        }
    }

    #[inline(always)]
    unsafe fn bit(&self, position: usize) -> u32 {
        ((*self.bytes.add(position >> 3) as u32) >> (7 - (position & 7))) & 1
    }

    /// 140103970 dereferences the current byte even when `count` is zero.
    #[inline(always)]
    unsafe fn read(&mut self, count: u32) -> Option<u32> {
        let first = self.position >> 3;
        if (self.position + count.max(1) as usize - 1) >> 3 >= self.length {
            return None;
        }
        if count == 0 {
            return Some(0);
        }
        let value = if first + 4 <= self.length {
            let word = u32::from_be_bytes(read_unaligned(self.bytes.add(first) as *const [u8; 4]));
            (word << (self.position & 7)) >> (32 - count)
        } else {
            let mut value = 0;
            for index in 0..count as usize {
                value = (value << 1) | self.bit(self.position + index);
            }
            value
        };
        self.position += count as usize;
        Some(value)
    }
}

/// 140103b40: an eight-bit speculative lookup; a short code near the end of the
/// stream resolves only when every completion of its defined bits agrees.
#[inline(always)]
unsafe fn symbol(bits: &mut Bits, tree: *const u32) -> Option<u32> {
    let leaves = *tree;
    let capacity = *tree.add(1);
    let lookup = tree.add(2);
    let children = tree.add(258);
    let entry = if (bits.position + 7) >> 3 < bits.length {
        let position = bits.position;
        let peek = bits.read(8)?;
        bits.position = position;
        *lookup.add(peek as usize)
    } else {
        let mut value = 0u32;
        let mut length = 0u32;
        while length < 8 {
            let position = bits.position + length as usize;
            if position >> 3 >= bits.length {
                break;
            }
            value = (value << 1) | bits.bit(position);
            length += 1;
        }
        let suffix = 8 - length;
        let first = value << suffix;
        let end = (value + 1) << suffix;
        let entry = *lookup.add(first as usize);
        if entry == UNDEFINED || entry >> 24 == 0 || entry >> 24 > length {
            return None;
        }
        for completion in first + 1..end {
            if *lookup.add(completion as usize) != entry {
                return None;
            }
        }
        entry
    };
    if entry == UNDEFINED {
        return None;
    }
    let length = entry >> 24;
    let mut node = entry & 0xff_ffff;
    if length != 0 {
        bits.position += length as usize;
        return Some(node);
    }
    bits.position += 8;
    while node >= leaves {
        if node >= capacity {
            return None;
        }
        let bit = bits.read(1)?;
        node = *children.add((node * 2 + bit) as usize);
    }
    Some(node)
}

#[inline(always)]
unsafe fn signed_bits(bits: &mut Bits, count: u32) -> Option<i32> {
    let value = bits.read(count)?;
    Some(if count != 0 && value < 1 << (count - 1) {
        value as i32 - ((1i32 << count) - 1)
    } else {
        value as i32
    })
}

/// One AAN pass over four independent lanes; every lane op is the reference's binary32 op.
#[inline(always)]
fn aan(v: &mut [v128; 8]) {
    let [a0, a1, a2, a3, a4, a5, a6, a7] = *v;
    let e0 = f32x4_add(a0, a4);
    let e1 = f32x4_sub(a0, a4);
    let e2 = f32x4_add(a2, a6);
    let e3 = f32x4_sub(f32x4_mul(f32x4_sub(a2, a6), f32x4_splat(1.4142135)), e2);
    let t0 = f32x4_add(e0, e2);
    let t3 = f32x4_sub(e0, e2);
    let t1 = f32x4_add(e1, e3);
    let t2 = f32x4_sub(e1, e3);
    let z13 = f32x4_add(a5, a3);
    let z10 = f32x4_sub(a5, a3);
    let z11 = f32x4_add(a1, a7);
    let z12 = f32x4_sub(a1, a7);
    let o7 = f32x4_add(z11, z13);
    let z5 = f32x4_mul(f32x4_add(z12, z10), f32x4_splat(1.847759));
    let o6 = f32x4_sub(f32x4_add(f32x4_mul(z10, f32x4_splat(-2.613126)), z5), o7);
    let o5 = f32x4_sub(f32x4_mul(f32x4_sub(z11, z13), f32x4_splat(1.4142135)), o6);
    let o4 = f32x4_add(o5, f32x4_sub(f32x4_mul(z12, f32x4_splat(1.0823922)), z5));
    *v = [
        f32x4_add(o7, t0),
        f32x4_add(o6, t1),
        f32x4_add(o5, t2),
        f32x4_sub(t3, o4),
        f32x4_add(o4, t3),
        f32x4_sub(t2, o5),
        f32x4_sub(t1, o6),
        f32x4_sub(t0, o7),
    ];
}

#[inline(always)]
fn transpose4(r: [v128; 4]) -> [v128; 4] {
    let t0 = i32x4_shuffle::<0, 4, 1, 5>(r[0], r[1]);
    let t1 = i32x4_shuffle::<2, 6, 3, 7>(r[0], r[1]);
    let t2 = i32x4_shuffle::<0, 4, 1, 5>(r[2], r[3]);
    let t3 = i32x4_shuffle::<2, 6, 3, 7>(r[2], r[3]);
    [
        i32x4_shuffle::<0, 1, 4, 5>(t0, t2),
        i32x4_shuffle::<2, 3, 6, 7>(t0, t2),
        i32x4_shuffle::<0, 1, 4, 5>(t1, t3),
        i32x4_shuffle::<2, 3, 6, 7>(t1, t3),
    ]
}

/// Columns of an 8x8 matrix held as `[half][row]`, four columns per vector.
#[inline(always)]
fn transpose8(m: &mut [[v128; 8]; 2]) {
    let a = transpose4([m[0][0], m[0][1], m[0][2], m[0][3]]);
    let b = transpose4([m[1][0], m[1][1], m[1][2], m[1][3]]);
    let c = transpose4([m[0][4], m[0][5], m[0][6], m[0][7]]);
    let d = transpose4([m[1][4], m[1][5], m[1][6], m[1][7]]);
    *m = [
        [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]],
        [c[0], c[1], c[2], c[3], d[0], d[1], d[2], d[3]],
    ];
}

/// MovieIdctWorkspace.transform, written back in place after PACKUSWB saturation.
/// `scaled` holds the reference's per-sample `quantization * scale` products.
#[inline(always)]
unsafe fn idct(block: *mut i16, scaled: *const f32) {
    let mut m = [[f32x4_splat(0.0); 8]; 2];
    for row in 0..8 {
        for half in 0..2 {
            let at = row * 8 + half * 4;
            let words = i32x4_extend_low_i16x8(v128_load64_zero(block.add(at) as *const u64));
            m[half][row] = f32x4_mul(
                f32x4_convert_i32x4(words),
                v128_load(scaled.add(at) as *const v128),
            );
        }
    }
    aan(&mut m[0]);
    aan(&mut m[1]);
    transpose8(&mut m);
    aan(&mut m[0]);
    aan(&mut m[1]);
    transpose8(&mut m);
    for row in 0..8 {
        let mut words = [i32x4_splat(0); 2];
        for half in 0..2 {
            let n = i32x4_trunc_sat_f32x4(m[half][row]);
            let n = i32x4_min(i32x4_max(n, i32x4_splat(-32768)), i32x4_splat(32767));
            let n = i32x4_add(i32x4_shr(n, 3), i32x4_splat(128));
            words[half] = i32x4_min(i32x4_max(n, i32x4_splat(0)), i32x4_splat(255));
        }
        v128_store(
            block.add(row * 8) as *mut v128,
            i16x8_narrow_i32x4(words[0], words[1]),
        );
    }
}

#[inline(always)]
fn clip(value: f32) -> u8 {
    (value as i32).clamp(0, 255) as u8
}

#[inline(always)]
unsafe fn color(table: *const f32, base: i32, index: i16) -> Option<f32> {
    let at = base + index as i32;
    if !(0..1024).contains(&at) {
        return None;
    }
    Some(*table.add(at as usize))
}

/// The row's own coefficients are defined for `length` entries from `start`.
#[inline(always)]
unsafe fn require(frame: &BfFrame, end: usize, start: usize, length: usize) -> Option<()> {
    if start + length > end {
        return None;
    }
    // Definition bytes are only ever 0 or 1.
    let mut index = start;
    while index + 8 <= start + length {
        if read_unaligned(frame.defined.add(index) as *const u64) != 0x0101_0101_0101_0101 {
            return None;
        }
        index += 8;
    }
    while index < start + length {
        if *frame.defined.add(index) == 0 {
            return None;
        }
        index += 1;
    }
    Some(())
}

/// Three transformed planes: every sample was required with its block and saturated to
/// 0..=255, so the reference's group reads and table lookups cannot fault.
#[inline(always)]
unsafe fn convert_block(
    frame: &BfFrame,
    first: *const i16,
    stride: usize,
    pixels: *mut u8,
    columns: usize,
    rows: usize,
) {
    let table = frame.color_table;
    let width = frame.width as usize;
    for yy in 0..rows {
        let mut at = yy * width * 4;
        for xx in 0..columns {
            let sample = yy * 8 + xx;
            let luma = *first.add(sample) as f32;
            let cb = *first.add(stride + sample) as usize;
            let cr = *first.add(stride * 2 + sample) as usize;
            *pixels.add(at) = clip(luma + *table.add(768 + cb));
            *pixels.add(at + 1) = clip((*table.add(256 + cb) + luma) + *table.add(512 + cr));
            *pixels.add(at + 2) = clip(luma + *table.add(cr));
            at += 4;
        }
    }
}

/// 104010/103C70 into the row's region, then the 105cf0 color worker.
unsafe fn decode_row(frame: &BfFrame, row: usize) -> Option<()> {
    let descriptor = frame.descriptors.add(row * 4);
    let start = *descriptor as usize;
    let count = *descriptor.add(1) as usize;
    let data_start = *descriptor.add(2) as usize;
    let limit = *descriptor.add(3) as usize;
    if count == 0 {
        return Some(());
    }
    let columns = frame.columns as usize;
    let mask_size = (columns + 7) >> 3;
    if start as u64 + mask_size as u64 > frame.frame_length as u64 {
        return None;
    }
    let region = frame.aligned_width as usize * 24;
    let base = row * region;
    let end = base + region;
    if count > region {
        return None;
    }
    let cleared = count.div_ceil(8) * 8;
    if cleared > region {
        return None;
    }
    let coefficients = frame.coefficients;
    core::ptr::write_bytes(frame.defined.add(base), 0, region);
    core::ptr::write_bytes(coefficients.add(base), 0, cleared);
    core::ptr::write_bytes(frame.defined.add(base), 1, cleared);

    let dc_tree = frame.dc_tree;
    let mut dc_bits = Bits::new(frame, data_start);
    let mut dc = 0i32;
    let mut index = 0;
    while index < count && dc_bits.position >> 3 < limit {
        let size = symbol(&mut dc_bits, dc_tree)?;
        dc = ((dc + signed_bits(&mut dc_bits, size)?) << 16) >> 16;
        *coefficients.add(base + index) = dc as i16;
        index += 64;
    }
    let ac_tree = frame.ac_tree;
    let mut ac_bits = Bits::new(frame, data_start + dc_bits.position.div_ceil(8));
    index = 0;
    while index < count && ac_bits.position >> 3 < limit {
        let mut order = 1;
        while order < 64 {
            let code = symbol(&mut ac_bits, ac_tree)?;
            if code == 0 {
                break;
            }
            if code == 15 {
                order += 16;
                continue;
            }
            let target_order = order + (code & 15) as usize;
            if target_order >= 64 {
                return None;
            }
            let at = base + index + ZIGZAG[target_order] as usize;
            if at >= end {
                return None;
            }
            *coefficients.add(at) = signed_bits(&mut ac_bits, (code >> 4) & 15)? as i16;
            *frame.defined.add(at) = 1;
            order = target_order + 1;
        }
        index += 64;
    }

    let channels = frame.depth as usize >> 3;
    let components = if channels == 4 { 3 } else { channels };
    if components == 0 {
        return None;
    }
    let stride = if components == 1 {
        0
    } else {
        (count >> 3) / components * 8
    };
    let mask = frame.frame.add(start);
    let mut scaled = [0f32; 128];
    for (index, value) in scaled.iter_mut().enumerate() {
        *value = *frame.quantization.add(index) as f32 * AAN_SCALE[index & 63];
    }
    let table = frame.color_table;
    let width = frame.width as usize;
    let height = frame.height as usize;
    let pixels = frame.surface;
    let initialized = frame.initialized;
    let mut block = 0;
    for column in 0..columns {
        if *mask.add(column >> 3) & (1 << (column & 7)) == 0 {
            continue;
        }
        for component in 0..components {
            let at = base + component * stride + block * 64;
            require(frame, end, at, 64)?;
            idct(
                coefficients.add(at),
                scaled.as_ptr().add(if component == 0 { 0 } else { 64 }),
            );
        }
        let first = base + block * 64;
        if components == 3 && initialized.is_null() {
            convert_block(
                frame,
                coefficients.add(first),
                stride,
                pixels.add((row * 8 * width + column * 8) * 4),
                (width - column * 8).min(8),
                (height - row * 8).min(8),
            );
            block += 1;
            continue;
        }
        let mut yy = 0;
        while yy < 8 && row * 8 + yy < height {
            let mut xx = 0;
            while xx < 8 && column * 8 + xx < width {
                let sample = yy * 8 + xx;
                let at = ((row * 8 + yy) * width + column * 8 + xx) * 4;
                if xx & 3 == 0 {
                    // Native reads each SIMD group of four words even for a cropped tail.
                    for plane in 0..3 {
                        require(frame, end, first + plane * stride + sample, 4)?;
                    }
                    if components != 1 {
                        for tail in 0..4 {
                            let cb = *coefficients.add(first + stride + sample + tail);
                            let cr = *coefficients.add(first + stride * 2 + sample + tail);
                            color(table, 768, cb)?;
                            color(table, 256, cb)?;
                            color(table, 512, cr)?;
                            color(table, 0, cr)?;
                        }
                    }
                }
                let y = *coefficients.add(first + sample);
                if components == 1 {
                    let value = y as u8;
                    *pixels.add(at) = value;
                    *pixels.add(at + 1) = value;
                    *pixels.add(at + 2) = value;
                } else {
                    let cb = *coefficients.add(first + stride + sample);
                    let cr = *coefficients.add(first + stride * 2 + sample);
                    let luma = y as f32;
                    *pixels.add(at) = clip(luma + color(table, 768, cb)?);
                    *pixels.add(at + 1) =
                        clip((color(table, 256, cb)? + luma) + color(table, 512, cr)?);
                    *pixels.add(at + 2) = clip(luma + color(table, 0, cr)?);
                }
                if !initialized.is_null() {
                    core::ptr::write_bytes(initialized.add(at), 1, 3);
                }
                xx += 1;
            }
            yy += 1;
        }
        block += 1;
    }
    Some(())
}

#[inline(always)]
unsafe fn mark(frame: &BfFrame, at: usize) {
    if !frame.initialized.is_null() {
        *frame.initialized.add(at) = 1;
    }
}

/// Alpha codec 1: LZ over the alpha bytes, referencing prior destination bytes.
unsafe fn decode_alpha_lz(frame: &BfFrame) -> Option<()> {
    let bits = Bits::new(frame, frame.alpha_start as usize);
    let bytes = bits.bytes;
    let length = bits.length;
    let pixels = frame.surface;
    let pixel_length = frame.surface_length as usize;
    let extent = frame.frame_extent as usize;
    let stride = (frame.width as i32).wrapping_mul(4);
    let mut cursor = 0;
    let mut output = 3usize;
    while output < extent {
        if cursor >= length {
            return None;
        }
        let control = *bytes.add(cursor);
        cursor += 1;
        let mut bit = 0;
        while bit < 8 && output < extent {
            if control & (1 << bit) != 0 {
                if cursor + 2 > length {
                    return None;
                }
                let code = u16::from_le_bytes([*bytes.add(cursor), *bytes.add(cursor + 1)]) as i32;
                cursor += 2;
                let mut dx = code & 63;
                let mut dy = (code >> 6) & 7;
                if dx > 31 {
                    dx -= 64;
                }
                if dy != 0 {
                    dy -= 8;
                }
                let count = (code >> 9) + 3;
                let distance = dy.wrapping_mul(stride).wrapping_add(dx * 4) as u32;
                for _ in 0..count {
                    let source = (output as u32).wrapping_add(distance) as usize;
                    if source >= pixel_length || output >= pixel_length {
                        return None;
                    }
                    if !frame.initialized.is_null() && *frame.initialized.add(source) == 0 {
                        return None;
                    }
                    *pixels.add(output) = *pixels.add(source);
                    mark(frame, output);
                    output += 4;
                }
            } else {
                if cursor >= length {
                    return None;
                }
                *pixels.add(output) = *bytes.add(cursor);
                cursor += 1;
                mark(frame, output);
                output += 4;
            }
            bit += 1;
        }
    }
    Some(())
}

/// Alpha codec 2: Huffman bytes, a block mask, then the masked blocks' alpha.
unsafe fn decode_alpha_blocks(frame: &BfFrame) -> Option<()> {
    let header = Bits::new(frame, frame.alpha_start as usize);
    if header.length < 4 {
        return None;
    }
    let size = u32::from_le_bytes(read_unaligned(header.bytes as *const [u8; 4])) as usize;
    let mut bits = Bits::new(
        frame,
        frame.alpha_start as usize + frame.alpha_bits_start as usize,
    );
    if size > frame.decoded_length as usize {
        return None;
    }
    let decoded = frame.decoded;
    for index in 0..size {
        *decoded.add(index) = symbol(&mut bits, frame.alpha_tree)? as u8;
    }
    let columns = frame.columns as usize;
    let rows = frame.rows as usize;
    let mask_size = (columns * rows + 7) >> 3;
    if mask_size > size {
        return None;
    }
    let width = frame.width as usize;
    let height = frame.height as usize;
    let mut read = mask_size;
    for row in 0..rows {
        for column in 0..columns {
            let block = row * columns + column;
            if *decoded.add(block >> 3) & (1 << (block & 7)) == 0 {
                continue;
            }
            for yy in row * 8..(row * 8 + 8).min(height) {
                for xx in column * 8..(column * 8 + 8).min(width) {
                    if read >= size {
                        return None;
                    }
                    let at = (yy * width + xx) * 4 + 3;
                    *frame.surface.add(at) = *decoded.add(read);
                    read += 1;
                    mark(frame, at);
                }
            }
        }
    }
    Some(())
}

unsafe fn decode_alpha(frame: &BfFrame) -> Option<()> {
    match frame.alpha_mode {
        0 => {
            let mut at = 3;
            while at < frame.frame_extent as usize {
                *frame.surface.add(at) = 0;
                mark(frame, at);
                at += 4;
            }
            Some(())
        }
        1 => decode_alpha_lz(frame),
        _ => decode_alpha_blocks(frame),
    }
}

unsafe fn decode_rows(frame: &BfFrame) -> Option<()> {
    for row in 0..frame.rows as usize {
        decode_row(frame, row)?;
    }
    Some(())
}

fn status(result: Option<()>) -> i32 {
    match result {
        Some(()) => BF_OK,
        None => BF_FAIL,
    }
}

/// The alpha work item into the staged surface. The host snapshots the surface
/// before the rows, so the alpha item can be published on its own.
#[no_mangle]
pub unsafe extern "C" fn bf_decode_alpha(frame: *const BfFrame) -> i32 {
    status(decode_alpha(&*frame))
}

/// Every row work item into the staged surface, after `bf_decode_alpha`.
#[no_mangle]
pub unsafe extern "C" fn bf_decode_rows(frame: *const BfFrame) -> i32 {
    status(decode_rows(&*frame))
}
