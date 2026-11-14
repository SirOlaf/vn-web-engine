//! Stereo WMA Pro subframes. LGPL-2.1-or-later; see src/formats/wma/NOTICE.
use super::{imdct::wma_imdct, standard::vlc, Bits};
use core::{arch::wasm32::*, slice};

/// The host allocates two consecutive 18-word channel records in this layout.
#[repr(C)]
struct Channel {
    previous_length: usize,
    count: usize,
    current: usize,
    decoded: usize,
    base: usize,
    transmit: u32,
    vector_count: usize,
    quant: i32,
    reuse: u32,
    scale_step: i32,
    maximum_scale: i32,
    scale_index: usize,
    table_index: usize,
    lengths: *const u16,
    output: *mut f32,
    saved: [*mut i32; 2],
    scales: *mut i32,
}
const _: () = assert!(core::mem::size_of::<Channel>() == 72);

/// State: channel records, reserved, band pointers/counts, scale-map pointers,
/// MDCT/window pointers, quant table, SF/SF-RL VLC pairs, SF run/level tables,
/// vec4/vec2/vec1 VLC pairs, coefficient directory, float scratch buffer.
/// Packet/frame metadata is parsed by the shared front end before this call.
#[no_mangle]
pub unsafe extern "C" fn wma_pro_frame(
    state: *const u32,
    input: *const u8,
    index: u32,
    size: u32,
) -> i32 {
    let s = slice::from_raw_parts(state, 22);
    let channels = slice::from_raw_parts_mut(s[0] as *mut Channel, 2);
    let mut g = Bits {
        data: input,
        index,
        size,
    };
    for c in channels.iter_mut() {
        c.current = 0;
        c.decoded = 0;
        c.reuse = 0;
    }
    for _ in 0..64 {
        if channels.iter().all(|c| c.decoded >= 2048) {
            return g.index as i32;
        }
        if subframe(s, channels, &mut g).is_err() {
            return -1;
        }
    }
    -1
}

unsafe fn subframe(s: &[u32], channels: &mut [Channel], g: &mut Bits) -> Result<(), ()> {
    let mut offset = 2048;
    let mut length = 2048;
    for c in channels.iter() {
        if c.decoded < offset {
            offset = c.decoded;
            length = *c.lengths.add(c.current) as usize;
        }
    }
    let mut active = [0_usize; 2];
    let mut count = 0;
    for (i, c) in channels.iter_mut().enumerate() {
        if c.decoded == offset && *c.lengths.add(c.current) as usize == length {
            c.decoded += length;
            c.base = offset + 1024;
            active[count] = i;
            count += 1;
        }
    }
    if count == 0
        || !(128..=2048).contains(&length)
        || !length.is_power_of_two()
        || offset + length > 2048
    {
        return Err(());
    }
    let table_index = 11 - length.ilog2() as usize;
    let bands = *((s[3] as *const u32).add(table_index)) as usize;
    let offsets = slice::from_raw_parts(
        *((s[2] as *const u32).add(table_index)) as *const i32,
        bands + 1,
    );
    if g.get(1) != 0 {
        let mut fill = g.get(2);
        if fill == 0 {
            let n = g.get(4);
            fill = g.get(n) + 1;
        }
        if g.index + fill > g.size {
            return Err(());
        }
        g.index += fill;
    }
    if g.get(1) != 0 || g.get(1) != 0 {
        return Err(());
    }
    let mut transform = false;
    if count == 2 {
        if g.get(1) != 0 {
            if g.get(1) != 0 {
                return Err(());
            }
        } else {
            transform = true;
        }
    }
    let mut transform_band = [0_u8; 29];
    if transform {
        if g.get(1) != 0 {
            transform_band[..bands].fill(1);
        } else {
            for b in &mut transform_band[..bands] {
                *b = g.get(1) as u8;
            }
        }
    }
    let mut any = false;
    for &ch in &active[..count] {
        channels[ch].transmit = g.get(1);
        any |= channels[ch].transmit != 0;
    }
    let mut transmit_vectors = false;
    if any {
        transmit_vectors = g.get(1) != 0;
        let vector_bits = ((length + 3) / 4).ilog2() + 1;
        for &ch in &active[..count] {
            let c = &mut channels[ch];
            c.vector_count = if transmit_vectors {
                (g.get(vector_bits) as usize) * 4
            } else {
                length
            };
            if c.vector_count > length {
                return Err(());
            }
        }
        let mut step = g.signed(6);
        let mut quant = 135 + step;
        if step == -32 || step == 31 {
            let sign = if step == 31 { 0 } else { -1 };
            let mut extra = 0;
            while g.index + 5 < g.size {
                step = g.get(5) as i32;
                if step != 31 {
                    break;
                }
                extra += 31;
            }
            quant += ((extra + step) ^ sign) - sign;
        }
        if count == 1 {
            channels[active[0]].quant = quant;
        } else {
            let bits = g.get(3);
            for &ch in &active[..count] {
                channels[ch].quant = quant;
                if g.get(1) != 0 {
                    channels[ch].quant += if bits != 0 { g.get(bits) as i32 + 1 } else { 1 };
                }
            }
        }
        for &ch in &active[..count] {
            scale_factors(s, &mut channels[ch], g, table_index, bands)?;
        }
    }
    for &ch in &active[..count] {
        let c = &mut channels[ch];
        if c.transmit != 0 && g.index < g.size {
            coefficients(s, c, g, length, transmit_vectors)?;
        } else {
            slice::from_raw_parts_mut(c.output.add(c.base), length).fill(0.0);
        }
    }
    if any {
        if transform {
            stereo(
                &channels[active[0]],
                &channels[active[1]],
                offsets,
                &transform_band,
            );
        }
        let scratch = s[21] as *mut f32;
        let quant_table = s[7] as *const f32;
        let plan = *((s[5] as *const u32).add(table_index)) as *const u32;
        for &ch in &active[..count] {
            let c = &channels[ch];
            for b in 0..bands {
                let exponent = c.quant - (c.maximum_scale - *c.scales.add(b)) * c.scale_step;
                let quant = if exponent < -903 {
                    0.0
                } else if exponent > 770 {
                    f32::INFINITY
                } else {
                    *quant_table.add((exponent + 903) as usize)
                };
                let start = offsets[b] as usize;
                let end = (offsets[b + 1] as usize).min(length);
                let input = c.output.add(c.base);
                let mul = f32x4_splat(quant);
                let mut i = start;
                while i + 4 <= end {
                    v128_store(
                        scratch.add(i).cast(),
                        f32x4_mul(v128_load(input.add(i).cast()), mul),
                    );
                    i += 4;
                }
                while i < end {
                    *scratch.add(i) = *input.add(i) * quant;
                    i += 1;
                }
            }
            wma_imdct(plan, scratch, c.output.add(c.base), 0);
        }
    }
    for &ch in &active[..count] {
        window(s, &mut channels[ch], length);
        if channels[ch].current >= channels[ch].count {
            return Err(());
        }
        channels[ch].current += 1;
    }
    Ok(())
}

unsafe fn scale_factors(
    s: &[u32],
    c: &mut Channel,
    g: &mut Bits,
    table: usize,
    bands: usize,
) -> Result<(), ()> {
    c.scales = c.saved[1 - c.scale_index];
    if c.reuse != 0 {
        let map = *((s[4] as *const u32).add(table * 5 + c.table_index)) as *const i32;
        for b in 0..bands {
            *c.scales.add(b) = *c.saved[c.scale_index].add(*map.add(b) as usize);
        }
    }
    if c.current == 0 || g.get(1) != 0 {
        if c.reuse == 0 {
            c.scale_step = g.get(2) as i32 + 1;
            let mut value = 45 / c.scale_step;
            for b in 0..bands {
                value += vlc(g, s[8], s[9], 8);
                *c.scales.add(b) = value;
            }
        } else {
            let mut b = 0;
            while b < bands {
                let index = vlc(g, s[10], s[11], 9);
                let (skip, value, sign);
                if index == 0 {
                    let code = g.get(14);
                    value = (code >> 6) as i32;
                    sign = (code & 1) as i32 - 1;
                    skip = ((code & 63) >> 1) as usize;
                } else if index == 1 {
                    break;
                } else {
                    if index < 0 {
                        return Err(());
                    }
                    skip = *((s[12] as *const u16).add(index as usize)) as usize;
                    value = *((s[13] as *const i16).add(index as usize)) as i32;
                    sign = g.get(1) as i32 - 1;
                }
                b += skip;
                if b >= bands {
                    return Err(());
                }
                *c.scales.add(b) += (value ^ sign) - sign;
                b += 1;
            }
        }
        c.scale_index = 1 - c.scale_index;
        c.table_index = table;
        c.reuse = 1;
    }
    c.maximum_scale = *c.scales;
    for b in 1..bands {
        c.maximum_scale = c.maximum_scale.max(*c.scales.add(b));
    }
    Ok(())
}

#[inline(always)]
unsafe fn large_value(g: &mut Bits) -> u32 {
    let mut n = 8;
    if g.get(1) != 0 {
        n += 8;
        if g.get(1) != 0 {
            n += 8;
            if g.get(1) != 0 {
                n += 7;
            }
        }
    }
    g.get(n)
}

unsafe fn coefficients(
    s: &[u32],
    c: &mut Channel,
    g: &mut Bits,
    length: usize,
    transmit_vectors: bool,
) -> Result<(), ()> {
    let dir = (s[20] as *const u32).add((g.get(1) as usize) * 4);
    let table = slice::from_raw_parts(dir, 4);
    let output = c.output.add(c.base);
    let mut rl = false;
    let mut coefficient = 0;
    let mut zeros = 0;
    const FLOATS: [f32; 16] = [
        0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0,
    ];
    while (transmit_vectors || !rl) && coefficient + 3 < c.vector_count {
        let mut values = [0_f32; 4];
        let mut index = vlc(g, s[14], s[15], 9);
        if index < 0 {
            for i in (0..4).step_by(2) {
                index = vlc(g, s[16], s[17], 9);
                if index < 0 {
                    for j in 0..2 {
                        let value = vlc(g, s[18], s[19], 9);
                        if value < 0 {
                            return Err(());
                        }
                        let value = if value == 100 {
                            (value as u32).wrapping_add(large_value(g))
                        } else {
                            value as u32
                        };
                        values[i + j] = value as f32;
                    }
                } else {
                    values[i] = FLOATS[(index >> 4) as usize];
                    values[i + 1] = FLOATS[(index & 15) as usize];
                }
            }
        } else {
            values[0] = FLOATS[(index >> 12) as usize];
            values[1] = FLOATS[((index >> 8) & 15) as usize];
            values[2] = FLOATS[((index >> 4) & 15) as usize];
            values[3] = FLOATS[(index & 15) as usize];
        }
        for value in values {
            if value != 0.0 {
                *output.add(coefficient) = if g.get(1) != 0 { value } else { -value };
                zeros = 0;
            } else {
                *output.add(coefficient) = 0.0;
                zeros += 1;
                rl |= zeros > length >> 8;
            }
            coefficient += 1;
        }
    }
    if coefficient < length {
        slice::from_raw_parts_mut(output.add(coefficient), length - coefficient).fill(0.0);
        while coefficient < length {
            let code = vlc(g, table[0], table[1], 9);
            if code > 1 {
                coefficient += *((table[2] as *const u16).add(code as usize)) as usize;
                let value = *((table[3] as *const f32).add(code as usize));
                *output.add(coefficient & (length - 1)) =
                    if g.get(1) != 0 { value } else { -value };
            } else if code == 1 {
                break;
            } else {
                let value = large_value(g) as i32;
                if g.get(1) != 0 {
                    if g.get(1) != 0 {
                        if g.get(1) != 0 {
                            return Err(());
                        }
                        coefficient += g.get(length.ilog2()) as usize + 4;
                    } else {
                        coefficient += g.get(2) as usize + 1;
                    }
                }
                let sign = g.get(1) as i32 - 1;
                *output.add(coefficient & (length - 1)) = ((value ^ sign) - sign) as f32;
            }
            coefficient += 1;
        }
        if coefficient > length {
            return Err(());
        }
    }
    Ok(())
}

unsafe fn stereo(a: &Channel, b: &Channel, offsets: &[i32], bands: &[u8]) {
    let a = a.output.add(a.base);
    let b = b.output.add(b.base);
    for band in 0..offsets.len() - 1 {
        let start = offsets[band] as usize;
        let end = offsets[band + 1] as usize;
        for i in (start..end).step_by(4) {
            let x = v128_load(a.add(i).cast());
            let y = v128_load(b.add(i).cast());
            let (left, right) = if bands[band] != 0 {
                (f32x4_sub(x, y), f32x4_add(x, y))
            } else {
                let mul = f32x4_splat(181.0 / 128.0);
                (f32x4_mul(x, mul), f32x4_mul(y, mul))
            };
            v128_store(a.add(i).cast(), left);
            v128_store(b.add(i).cast(), right);
        }
    }
}

unsafe fn window(s: &[u32], c: &mut Channel, length: usize) {
    let n = c.previous_length.min(length);
    let half = n / 2;
    let start = c.output.add(c.base - half);
    let win = *((s[6] as *const u32).add(11 - n.ilog2() as usize)) as *const f32;
    for i in (0..half).step_by(4) {
        let back = 2 * half - i - 4;
        let x = v128_load(start.add(i).cast());
        let y = v128_load(start.add(back).cast());
        let y = i32x4_shuffle::<3, 2, 1, 0>(y, y);
        let wi = v128_load(win.add(i).cast());
        let wj = v128_load(win.add(back).cast());
        let wj = i32x4_shuffle::<3, 2, 1, 0>(wj, wj);
        let left = f32x4_sub(f32x4_mul(x, wj), f32x4_mul(y, wi));
        let right = f32x4_add(f32x4_mul(x, wi), f32x4_mul(y, wj));
        v128_store(start.add(i).cast(), left);
        v128_store(
            start.add(back).cast(),
            i32x4_shuffle::<3, 2, 1, 0>(right, right),
        );
    }
    c.previous_length = length;
}
