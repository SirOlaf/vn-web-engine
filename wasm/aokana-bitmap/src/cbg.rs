//! Legacy CompressedBG entropy, run and predictor stages (0x1400bfa50). Mirrors
//! `decodeLegacy` in `src/formats/buriko/compressed-bg.ts`, which stays the
//! reference: every failure returns a negative status, and the host reruns the
//! TypeScript stages to raise the exact native error. The frequency tree,
//! checksum and header publication remain in TypeScript.
//!
//! Every stage is resumable. Callers pass the resumed state explicitly, and the
//! updated state is returned or left in `STATE`; state never survives in this
//! module between host calls. Host-owned pointers live in a dedicated instance.

use core::arch::wasm32::*;

const ABSENT: u32 = 511;
const ABSENT_CHILD: u16 = 0xffff;
/// Bits kept unread at the end of a nonfinal window: a sixteen-bit prefix plus
/// the longest code of a 256-leaf tree (255 bits), rounded up.
pub const CBG_WINDOW_MARGIN_BITS: usize = 1024;

pub const CBG_FAILED: i32 = -1;

static mut STATE: [u32; 4] = [0; 4];

/// Address of the four-word state written by `cbg_entropy` and `cbg_runs`.
#[no_mangle]
pub unsafe extern "C" fn cbg_state() -> *const u32 {
    core::ptr::addr_of!(STATE) as *const u32
}

#[inline(always)]
unsafe fn child(children: *const u16, node: u32, bit: u32) -> u32 {
    let value = *children.add((node * 2 + bit) as usize);
    if value == ABSENT_CHILD {
        ABSENT
    } else {
        value as u32
    }
}

/// Table layout for `prefix_bits` = P: `1 << P` length bytes (total code length
/// (5) and count (3) of up to four complete symbols), then `1 << P` u32 symbol
/// words, then `1 << P` u16 first-node entries (consumed bits (5) and the node
/// reached by the prefix (9; 511 is an absent child)). Only the length bytes
/// are on the decoder's dependency chain, so they are kept apart.
unsafe fn fill_prefixes(
    nodes: *mut u16,
    children: *const u16,
    node: u32,
    prefix: usize,
    consumed: u32,
    prefix_bits: u32,
) {
    if node == ABSENT || node < 256 || consumed == prefix_bits {
        let remaining = prefix_bits - consumed;
        let entry = ((node << 5) | consumed) as u16;
        for slot in (prefix << remaining)..((prefix + 1) << remaining) {
            *nodes.add(slot) = entry;
        }
        return;
    }
    fill_prefixes(
        nodes,
        children,
        child(children, node, 0),
        prefix << 1,
        consumed + 1,
        prefix_bits,
    );
    fill_prefixes(
        nodes,
        children,
        child(children, node, 1),
        (prefix << 1) | 1,
        consumed + 1,
        prefix_bits,
    );
}

/// Builds the `7 << prefix_bits` bytes of lookup tables at `tables`
/// from `children` (two u16 slots per node, 0xffff for an absent child).
#[no_mangle]
pub unsafe extern "C" fn cbg_tables(
    tables: *mut u8,
    children: *const u16,
    root: u32,
    prefix_bits: u32,
) {
    let slots = 1usize << prefix_bits;
    let lengths = tables;
    let symbols = tables.add(slots) as *mut u32;
    let nodes = tables.add(slots * 5) as *mut u16;
    fill_prefixes(nodes, children, root, 0, 0, prefix_bits);
    let mask = slots - 1;
    for prefix in 0..slots {
        let mut consumed = 0u32;
        let mut count = 0u32;
        let mut packed = 0u32;
        while count < 4 {
            let next = *nodes.add((prefix << consumed) & mask) as u32;
            let node = next >> 5;
            let total = consumed + (next & 31);
            if node >= 256 || total > prefix_bits {
                break;
            }
            packed |= node << (count * 8);
            consumed = total;
            count += 1;
        }
        *lengths.add(prefix) = (consumed | (count << 5)) as u8;
        *symbols.add(prefix) = packed;
    }
}

/// Stream bits from `position`, most significant first; at least 57 are valid.
/// Windows carry eight zero padding bytes.
#[inline(always)]
unsafe fn load_bits(window: *const u8, position: usize) -> u64 {
    u64::from_be_bytes(core::ptr::read_unaligned(
        window.add(position >> 3) as *const [u8; 8]
    )) << (position & 7)
}

/// Decodes symbols `index..end` (at most `total`) from a staged window of the
/// bitstream, starting `bit` bits into the window. A final window ends at the
/// stream end; otherwise decoding stops once fewer than
/// `CBG_WINDOW_MARGIN_BITS` bits remain, so every code seen is complete. The
/// output has four bytes of slack after `total`. Returns the next index, with
/// the window bit position in `STATE[0]`, or `CBG_FAILED` for an absent child
/// or a truncated stream.
#[no_mangle]
pub unsafe extern "C" fn cbg_entropy(
    tables: *const u8,
    children: *const u16,
    root: u32,
    prefix_bits: u32,
    window: *const u8,
    window_bytes: usize,
    final_window: u32,
    bit: usize,
    output: *mut u8,
    index: usize,
    end: usize,
    total: usize,
) -> i32 {
    let slots = 1usize << prefix_bits;
    let lengths = tables;
    let symbols = tables.add(slots) as *const u32;
    let nodes = tables.add(slots * 5) as *const u16;
    let prefix_bits = prefix_bits as usize;
    let window_bits = window_bytes * 8;
    let stop = if final_window != 0 {
        usize::MAX
    } else {
        window_bits - CBG_WINDOW_MARGIN_BITS
    };
    let shift = 64 - prefix_bits;
    let mut position = bit;
    // `bits` holds `available` stream bits from `position`, most significant first.
    let mut bits = 0u64;
    let mut available = 0usize;
    let mut i = index;
    while i < end && position <= stop {
        if available < prefix_bits {
            bits = load_bits(window, position);
            available = 64 - (position & 7);
        }
        let mut node;
        if window_bits - position >= prefix_bits {
            let prefix = (bits >> shift) as usize;
            let packed = *lengths.add(prefix) as usize;
            let count = packed >> 5;
            if count != 0 && i + count <= total {
                core::ptr::write_unaligned(
                    output.add(i) as *mut u32,
                    (*symbols.add(prefix)).to_le(),
                );
                let length = packed & 31;
                bits <<= length;
                available -= length;
                position += length;
                i += count;
                continue;
            }
            let first = *nodes.add(prefix) as u32;
            node = first >> 5;
            if node == ABSENT {
                return CBG_FAILED;
            }
            let length = (first & 31) as usize;
            bits <<= length;
            available -= length;
            position += length;
        } else {
            node = root;
        }
        if node >= 256 {
            available = 0;
            while node >= 256 {
                if position >= window_bits {
                    return CBG_FAILED;
                }
                let value = (*window.add(position >> 3) as u32 >> (7 - (position & 7))) & 1;
                position += 1;
                node = child(children, node, value);
                if node == ABSENT {
                    return CBG_FAILED;
                }
            }
        }
        *output.add(i) = node as u8;
        i += 1;
    }
    STATE[0] = position as u32;
    i as i32
}

/// Readable bytes after `input_length` and writable bytes after `size` that
/// `cbg_runs` may touch; the written slack holds no meaningful output.
pub const RUN_SLACK: usize = 32;

/// Expands alternating literal and zero runs of `input` into `output` (`size`
/// bytes), resuming at `cursor`, `written` and `literal`. Both buffers carry
/// `RUN_SLACK` bytes of slack. A step ends once it
/// has consumed and written `budget` bytes combined. Returns 0 when the input
/// is exhausted and exactly fills the output, 1 with the resumed state in
/// `STATE[0..3]`, or `CBG_FAILED` for any varint, range or size error.
#[no_mangle]
pub unsafe extern "C" fn cbg_runs(
    input: *const u8,
    input_length: usize,
    cursor: usize,
    output: *mut u8,
    size: usize,
    written: usize,
    literal: u32,
    budget: usize,
) -> i32 {
    let mut cursor = cursor;
    let mut p = written;
    let mut literal = literal != 0;
    let limit = cursor as u64 + p as u64 + budget as u64;
    while cursor < input_length {
        if cursor as u64 + p as u64 >= limit {
            STATE[0] = cursor as u32;
            STATE[1] = p as u32;
            STATE[2] = literal as u32;
            return 1;
        }
        let mut count = 0u64;
        let mut shift = 0u32;
        loop {
            if cursor >= input_length {
                return CBG_FAILED;
            }
            let byte = *input.add(cursor);
            cursor += 1;
            if shift == 28 && byte > 15 {
                return CBG_FAILED;
            }
            count += ((byte & 127) as u64) << shift;
            if byte & 128 == 0 {
                break;
            }
            shift += 7;
        }
        if count > (size - p) as u64 {
            return CBG_FAILED;
        }
        let count = count as usize;
        // Most runs are a few bytes long. Short runs store thirty-two bytes and let
        // the next run overwrite the excess, avoiding a bulk-memory call per run.
        if literal {
            if count > input_length - cursor {
                return CBG_FAILED;
            }
            if count <= RUN_SLACK {
                let (from, to) = (input.add(cursor), output.add(p));
                v128_store(to as *mut v128, v128_load(from as *const v128));
                v128_store(to.add(16) as *mut v128, v128_load(from.add(16) as *const v128));
            } else {
                core::ptr::copy_nonoverlapping(input.add(cursor), output.add(p), count);
            }
            cursor += count;
        } else if count <= RUN_SLACK {
            v128_store(output.add(p) as *mut v128, u64x2_splat(0));
            v128_store(output.add(p + 16) as *mut v128, u64x2_splat(0));
        } else {
            core::ptr::write_bytes(output.add(p), 0, count);
        }
        p += count;
        literal = !literal;
    }
    if p != size {
        return CBG_FAILED;
    }
    0
}

/// Spreads four bytes into the low bytes of four sixteen-bit lanes.
#[inline(always)]
fn widen(value: u32) -> u64 {
    let value = value as u64;
    let value = (value | (value << 16)) & 0x0000_ffff_0000_ffff;
    (value | (value << 8)) & 0x00ff_00ff_00ff_00ff
}

#[inline(always)]
fn narrow(value: u64) -> u32 {
    let value = (value | (value >> 8)) & 0x0000_ffff_0000_ffff;
    (value | (value >> 16)) as u32
}

const LANES: u64 = 0x00ff_00ff_00ff_00ff;

/// Reconstructs rows `first_row..end_row` of 8-, 24- or 32-bit residuals.
/// Every byte lane adds its left neighbour on row 0, its upper neighbour in
/// column 0, and otherwise the floored average of both, wrapping to a byte.
/// 24-bit residuals expand to BGR0 output rows whose fourth byte is always
/// zero, whatever the row above holds; 8- and 32-bit output may alias the
/// residuals. Rows before `first_row` must already hold output pixels,
/// and 24-bit residuals carry one byte of slack.
#[no_mangle]
pub unsafe extern "C" fn cbg_predict(
    residuals: *const u8,
    output: *mut u8,
    width: usize,
    channels: u32,
    first_row: usize,
    end_row: usize,
) {
    match channels {
        1 => {
            for y in first_row..end_row {
                let row = y * width;
                let input = residuals.add(row);
                let pixels = output.add(row);
                if y == 0 {
                    let mut left = *input;
                    *pixels = left;
                    for x in 1..width {
                        left = left.wrapping_add(*input.add(x));
                        *pixels.add(x) = left;
                    }
                } else {
                    let up = output.add(row - width);
                    let mut left = (*input).wrapping_add(*up);
                    *pixels = left;
                    for x in 1..width {
                        let average = ((*up.add(x) as u32 + left as u32) >> 1) as u8;
                        left = (*input.add(x)).wrapping_add(average);
                        *pixels.add(x) = left;
                    }
                }
            }
        }
        3 | 4 => {
            // Sixteen-bit lanes hold each byte channel. A lane sum of two bytes
            // cannot carry into its neighbour; the shift's stray top bit and the
            // following byte addition stay below bit 16, and one mask per pixel
            // retains the low byte. Masking the row above keeps the fourth
            // 24-bit lane zero.
            let (input_stride, mask, above_mask) = if channels == 4 {
                (width * 4, u32::MAX, LANES)
            } else {
                (width * 3, 0x00ff_ffff, 0x0000_00ff_00ff_00ff)
            };
            let load = |row: *const u8, x: usize| -> u64 {
                widen(
                    u32::from_le(core::ptr::read_unaligned(
                        row.add(x * channels as usize) as *const u32
                    )) & mask,
                )
            };
            for y in first_row..end_row {
                let input = residuals.add(y * input_stride);
                let pixels = output.add(y * width * 4) as *mut u32;
                if y == 0 {
                    let mut left = load(input, 0);
                    core::ptr::write_unaligned(pixels, narrow(left).to_le());
                    for x in 1..width {
                        left = (load(input, x) + left) & LANES;
                        core::ptr::write_unaligned(pixels.add(x), narrow(left).to_le());
                    }
                } else {
                    let up = pixels.sub(width) as *const u32;
                    let above = |x: usize| -> u64 {
                        widen(u32::from_le(core::ptr::read_unaligned(up.add(x)))) & above_mask
                    };
                    let mut left = (load(input, 0) + above(0)) & LANES;
                    core::ptr::write_unaligned(pixels, narrow(left).to_le());
                    for x in 1..width {
                        left = (load(input, x) + ((above(x) + left) >> 1)) & LANES;
                        core::ptr::write_unaligned(pixels.add(x), narrow(left).to_le());
                    }
                }
            }
        }
        _ => {}
    }
}
