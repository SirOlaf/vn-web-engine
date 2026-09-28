//! DSC FORMAT 1.00 decoding (BGI_DSC_BuildDecodeTree / DecodeSymbols,
//! 0x1400b8390 / 0x1400b8220). Mirrors `src/formats/buriko/dsc.ts`, which stays
//! the reference: every failure returns a nonzero status, and the host reruns
//! the TypeScript decoder to raise the exact native error.

use core::arch::wasm32::*;

const HEADER: usize = 0x220;
const MAX_NODES: usize = 1023;
const PREFIX_BITS: u32 = 12;

pub const DSC_OK: i32 = 0;
const DSC_HEADER: i32 = 1;
const DSC_TREE: i32 = 2;
const DSC_CODE: i32 = 3;
const DSC_TRUNCATED: i32 = 4;
const DSC_BACKREFERENCE: i32 = 5;
const DSC_OVERFLOW: i32 = 6;
const DSC_SIZE: i32 = 7;

// Synchronous host calls cannot interleave while this decoder owns the tables.
// Node symbols are -1 for internal or empty nodes. A zero first child marks a
// node without children (the root is never a child).
static mut NODE_SYMBOL: [i32; MAX_NODES + 1] = [0; MAX_NODES + 1];
static mut NODE_CHILD: [u16; MAX_NODES + 1] = [0; MAX_NODES + 1];
// >0: (symbol << 10) | (code and distance bits << 5) | code length; <0: -(depth-12 internal node); 0: invalid code.
static mut PREFIX: [i32; 1 << PREFIX_BITS] = [0; 1 << PREFIX_BITS];

#[inline(always)]
unsafe fn read_u32_le(bytes: *const u8, offset: usize) -> u32 {
    u32::from_le_bytes(core::ptr::read_unaligned(
        bytes.add(offset) as *const [u8; 4]
    ))
}

#[inline(always)]
unsafe fn read_u64_be(bytes: *const u8) -> u64 {
    u64::from_be_bytes(core::ptr::read_unaligned(bytes as *const [u8; 8]))
}

/// The top 25 bits are the next stream bits, most significant first. The host
/// pads the input with eight zero bytes.
#[inline(always)]
unsafe fn peek(input: *const u8, position: usize) -> u32 {
    u32::from_be_bytes(core::ptr::read_unaligned(
        input.add(position >> 3) as *const [u8; 4]
    )) << (position & 7)
}

unsafe fn fill_prefixes(index: usize, prefix: usize, depth: u32) {
    let symbol = NODE_SYMBOL[index];
    if symbol >= 0 {
        let suffix = PREFIX_BITS - depth;
        let consumed = depth as i32 + if symbol >= 256 { 12 } else { 0 };
        let entry = (symbol << 10) | (consumed << 5) | depth as i32;
        for slot in (prefix << suffix)..((prefix + 1) << suffix) {
            PREFIX[slot] = entry;
        }
    } else if depth == PREFIX_BITS {
        // Empty depth-12 nodes still continue so the scalar walk reports them.
        PREFIX[prefix] = -(index as i32);
    } else {
        let child = NODE_CHILD[index] as usize;
        if child != 0 {
            fill_prefixes(child, prefix << 1, depth + 1);
            fill_prefixes(child + 1, (prefix << 1) | 1, depth + 1);
        }
        // Childless empty prefixes keep entry 0: every code through them is invalid.
    }
}

/// `input` holds `input_length` bytes followed by eight zero bytes. `output`
/// has room for `output_length` bytes, the header's decoded size, plus 16
/// bytes of slack for chunked back-reference copies.
#[no_mangle]
pub unsafe extern "C" fn dsc_decode(
    input: *const u8,
    input_length: usize,
    output: *mut u8,
    output_length: usize,
) -> i32 {
    if input_length < HEADER
        || core::slice::from_raw_parts(input, 16) != b"DSC FORMAT 1.00\0"
        || read_u32_le(input, 20) as usize != output_length
    {
        return DSC_HEADER;
    }
    let size = output_length;
    let tokens = read_u32_le(input, 24);

    // Code lengths use the native generator's high product bits before increment.
    let mut seed = read_u32_le(input, 16);
    let mut lengths = [0u8; 512];
    let mut counts = [0u16; 256];
    for symbol in 0..512 {
        let product = seed.wrapping_mul(0x015a4e35);
        seed = product.wrapping_add(1);
        let length = (*input.add(32 + symbol)).wrapping_sub((product >> 16) as u8);
        lengths[symbol] = length;
        counts[length as usize] += 1;
    }
    // Stable (length, symbol) order.
    let mut starts = [0u16; 256];
    let mut total = 0u16;
    for length in 1..256 {
        starts[length] = total;
        total += counts[length];
    }
    let symbol_count = total as usize;
    let mut sorted = [(0u16, 0u8); 512];
    for symbol in 0..512 {
        let length = lengths[symbol] as usize;
        if length != 0 {
            sorted[starts[length] as usize] = (symbol as u16, length as u8);
            starts[length] += 1;
        }
    }

    // Level-order canonical tree, including expansion of the remaining nodes of
    // the final level and the reference's node-count checks.
    NODE_SYMBOL[0] = -1;
    NODE_CHILD[0] = 0;
    let mut node_count = 1usize;
    let mut level = [0u16; MAX_NODES + 1];
    let mut next = [0u16; MAX_NODES + 1];
    let mut level_length = 1usize;
    let mut cursor = 0usize;
    let mut depth = 0usize;
    while cursor < symbol_count {
        let mut next_length = 0usize;
        for position in 0..level_length {
            let index = level[position] as usize;
            if cursor < symbol_count && sorted[cursor].1 as usize == depth {
                NODE_SYMBOL[index] = sorted[cursor].0 as i32;
                cursor += 1;
            } else {
                NODE_CHILD[index] = node_count as u16;
                next[next_length] = node_count as u16;
                next[next_length + 1] = node_count as u16 + 1;
                next_length += 2;
                NODE_SYMBOL[node_count] = -1;
                NODE_CHILD[node_count] = 0;
                NODE_SYMBOL[node_count + 1] = -1;
                NODE_CHILD[node_count + 1] = 0;
                node_count += 2;
                if node_count > MAX_NODES {
                    return DSC_TREE;
                }
            }
        }
        if next_length == 0 && cursor < symbol_count {
            return DSC_TREE;
        }
        level[..next_length].copy_from_slice(&next[..next_length]);
        level_length = next_length;
        depth += 1;
    }
    if symbol_count == 0 && tokens != 0 {
        return DSC_TREE;
    }
    if tokens != 0 {
        core::ptr::write_bytes(
            core::ptr::addr_of_mut!(PREFIX) as *mut i32,
            0,
            1 << PREFIX_BITS,
        );
        fill_prefixes(0, 0, 0);
    }

    let stream = input.add(HEADER);
    let stream_length = input_length - HEADER;
    let bit_length = stream_length * 8;
    // Buffered reading holds `bits` stream bits, most significant first, ending at
    // `next`; bits below them are zero or the correct following stream bits.
    // It runs while an eight-byte load stays within the stream, so every consumed
    // bit is real. `position` is authoritative only while `buffered` is false.
    let stream_end = stream.add(stream_length);
    let mut buffer = 0u64;
    let mut bits = 0u32;
    let mut next = stream;
    let mut buffered = true;
    let mut position = 0usize;
    let mut p = 0usize;
    for _ in 0..tokens {
        if buffered {
            if next.add(8) <= stream_end {
                buffer |= read_u64_be(next) >> bits;
                next = next.add(((63 - bits) >> 3) as usize);
                bits |= 56;
                // A one-lookup code and its twelve distance bits fit in 24 bits.
                // Literals and repeats of at most sixteen bytes avoid data-dependent
                // branches: both store one sixteen-byte chunk (a literal repeats
                // earlier workspace bytes, then sets its first byte); later tokens
                // or the host's slack absorb the excess.
                let entry = PREFIX[(buffer >> (64 - PREFIX_BITS)) as usize];
                if entry > 0 {
                    let length = (entry & 31) as u32;
                    let symbol = (entry >> 10) as usize;
                    let reference = symbol >= 256;
                    let distance = ((buffer << length) >> 52) as usize + 2;
                    let count = (symbol & 255) + 2;
                    let produced = if reference { count } else { 1 };
                    if (reference && distance > p) | (produced > size - p) {
                        return DSC_OVERFLOW;
                    }
                    let consumed = ((entry >> 5) & 31) as u32;
                    buffer <<= consumed;
                    bits -= consumed;
                    let target = output.add(p);
                    // Literals read the constant identity row instead of recently
                    // stored output, avoiding a store-forwarding dependency.
                    let row = if reference && distance < 16 {
                        distance
                    } else {
                        16
                    };
                    let source = if reference {
                        target.sub(distance) as *const u8
                    } else {
                        PATTERN[16].as_ptr()
                    };
                    let chunk = i8x16_swizzle(
                        v128_load(source as *const v128),
                        v128_load(PATTERN[row].as_ptr() as *const v128),
                    );
                    v128_store(
                        target as *mut v128,
                        if reference {
                            chunk
                        } else {
                            u8x16_splat(symbol as u8)
                        },
                    );
                    if reference && count > 16 {
                        continue_reference(target, distance, count, chunk);
                    }
                    p += produced;
                    continue;
                }
            }
            position = (next as usize - stream as usize) * 8 - bits as usize;
            buffered = false;
        }

        let mut node = 0usize;
        let mut symbol = -1i32;
        if position + PREFIX_BITS as usize <= bit_length {
            let entry = PREFIX[(peek(stream, position) >> (32 - PREFIX_BITS)) as usize];
            if entry > 0 {
                position += (entry & 31) as usize;
                symbol = entry >> 10;
            } else if entry < 0 {
                position += PREFIX_BITS as usize;
                node = (-entry) as usize;
            } else {
                return DSC_CODE;
            }
        }
        if symbol < 0 {
            loop {
                let value = NODE_SYMBOL[node];
                if value >= 0 {
                    symbol = value;
                    break;
                }
                if position >= bit_length {
                    return DSC_TRUNCATED;
                }
                let child = NODE_CHILD[node] as usize;
                if child == 0 {
                    return DSC_CODE;
                }
                node = child + (peek(stream, position) >> 31) as usize;
                position += 1;
            }
        }
        if symbol < 256 {
            if p >= size {
                return DSC_OVERFLOW;
            }
            *output.add(p) = symbol as u8;
            p += 1;
        } else {
            let count = (symbol as usize & 255) + 2;
            if position + 12 > bit_length {
                return DSC_TRUNCATED;
            }
            let distance = (peek(stream, position) >> 20) as usize + 2;
            position += 12;
            if distance > p {
                return DSC_BACKREFERENCE;
            }
            if count > size - p {
                return DSC_OVERFLOW;
            }
            let target = output.add(p);
            let chunk = first_chunk(target, distance);
            v128_store(target as *mut v128, chunk);
            continue_reference(target, distance, count, chunk);
            p += count;
        }
        // Resume buffered reading after a long code while the stream allows.
        if (position >> 3) + 8 <= stream_length {
            let skip = (position & 7) as u32;
            next = stream.add(position >> 3);
            buffer = read_u64_be(next) << skip;
            next = next.add(7);
            bits = 56 - skip;
            buffered = true;
        }
    }
    if p != size {
        return DSC_SIZE;
    }
    DSC_OK
}

// Row d < 16 repeats a distance-d seed across sixteen lanes; row 16 is identity.
const fn pattern_table() -> [[u8; 16]; 17] {
    let mut table = [[0u8; 16]; 17];
    let mut distance = 1;
    while distance <= 16 {
        let mut lane = 0;
        while lane < 16 {
            table[distance][lane] = (lane % distance) as u8;
            lane += 1;
        }
        distance += 1;
    }
    table
}
// Row d < 16 advances a repeated distance-d chunk by sixteen bytes.
const fn rotate_table() -> [[u8; 16]; 16] {
    let mut table = [[0u8; 16]; 16];
    let mut distance = 1;
    while distance < 16 {
        let mut lane = 0;
        while lane < 16 {
            table[distance][lane] = ((16 + lane) % distance) as u8;
            lane += 1;
        }
        distance += 1;
    }
    table
}
static PATTERN: [[u8; 16]; 17] = pattern_table();
static ROTATE: [[u8; 16]; 16] = rotate_table();

/// The first sixteen bytes of a repeat at `distance` >= 2, reading only bytes
/// before `target`. Literals pass 16 and read earlier workspace bytes. Stores
/// of this chunk may extend up to 15 bytes past a shorter repeat, into bytes a
/// later token replaces or the host's slack; this avoids `memory.copy` calls.
#[inline(always)]
unsafe fn first_chunk(target: *mut u8, distance: usize) -> v128 {
    let row = if distance < 16 { distance } else { 16 };
    i8x16_swizzle(
        v128_load(target.sub(distance) as *const v128),
        v128_load(PATTERN[row].as_ptr() as *const v128),
    )
}

/// Continues a repeat after its stored first chunk, sixteen bytes at a time.
#[inline(always)]
unsafe fn continue_reference(target: *mut u8, distance: usize, count: usize, chunk: v128) {
    let mut offset = 16usize;
    if distance < 16 {
        let rotate = v128_load(ROTATE[distance].as_ptr() as *const v128);
        let mut chunk = chunk;
        while offset < count {
            chunk = i8x16_swizzle(chunk, rotate);
            v128_store(target.add(offset) as *mut v128, chunk);
            offset += 16;
        }
    } else {
        while offset < count {
            v128_store(
                target.add(offset) as *mut v128,
                v128_load(target.add(offset - distance) as *const v128),
            );
            offset += 16;
        }
    }
}
