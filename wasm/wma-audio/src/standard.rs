//! WMA v2 variable-block entropy, coefficient reconstruction and overlap output.
//! LGPL-2.1-or-later; see src/formats/wma/NOTICE. All buffers live in the host arena.
use super::{imdct::wma_imdct, Bits};
use core::{arch::wasm32::*, ptr, slice};

#[inline(always)]
pub(super) unsafe fn vlc(g: &mut Bits, sym: u32, len: u32, width: u32) -> i32 {
    let sym = sym as *const i16;
    let len = len as *const i16;
    let mut index = g.show(width) as usize;
    let mut code = *sym.add(index) as i32;
    let mut n = *len.add(index) as i32;
    let mut used = width;
    for _ in 0..2 {
        if n >= 0 {
            break;
        }
        g.index = (g.index + used).min(g.size + 8);
        used = -n as u32;
        index = (g.show(used) as i32 + code) as usize;
        code = *sym.add(index) as i32;
        n = *len.add(index) as i32;
    }
    g.index = (g.index + n.max(0) as u32).min(g.size + 8);
    code
}

#[inline(always)]
unsafe fn block_bits(g: &mut Bits) -> Result<i32, ()> {
    let v = g.get(3);
    if v >= 5 {
        Err(())
    } else {
        Ok(11 - v as i32)
    }
}

/// State pointers and scalars are initialized by WmaStandardDecoder's arena host.
/// 0..3: reset/current/previous/next block lengths. 4..7: exponent VLC, powers,
/// gain table. 8..13: band directories, maximum/exponent-size/initialized/coded
/// arrays. 14..22: exponent/coefficient/level, transform and overlap buffers.
/// 23..25: MDCT-plan, window and coefficient-VLC directories. 26: variable blocks.
/// Returns the checked bit position, or -1 for malformed/truncated frame data.
#[no_mangle]
pub unsafe extern "C" fn wma_standard_frame(
    state: *mut i32,
    input: *const u8,
    index: u32,
    size: u32,
) -> i32 {
    let s = slice::from_raw_parts_mut(state, 27);
    let mut g = Bits {
        data: input,
        index,
        size,
    };
    let mut position = 0;
    while position < 2048 {
        match block(s, &mut g, position) {
            Ok(n) => position += n,
            Err(()) => return -1,
        }
    }
    g.index as i32
}

unsafe fn block(s: &mut [i32], g: &mut Bits, position: usize) -> Result<usize, ()> {
    if s[26] == 0 {
        s[1] = 11;
        s[2] = 11;
        s[3] = 11;
    } else if s[0] != 0 {
        s[0] = 0;
        s[2] = block_bits(g)?;
        s[1] = block_bits(g)?;
    } else {
        s[2] = s[1];
        s[1] = s[3];
    }
    if s[26] != 0 {
        s[3] = block_bits(g)?;
    }
    let length = 1_usize << s[1];
    let size = (11 - s[1]) as usize;
    if position + length > 2048 {
        return Err(());
    }
    let stereo = g.get(1) != 0;
    let coded = slice::from_raw_parts_mut(s[13] as *mut u8, 2);
    coded[0] = g.get(1) as u8;
    coded[1] = g.get(1) as u8;
    if coded[0] != 0 || coded[1] != 0 {
        let mut gain = 1_usize;
        loop {
            if g.index + 7 > g.size {
                return Err(());
            }
            let part = g.get(7) as usize;
            gain += part;
            if part != 127 {
                break;
            }
        }
        let coef_bits = if gain < 15 {
            13
        } else if gain < 32 {
            12
        } else if gain < 40 {
            11
        } else if gain < 45 {
            10
        } else {
            9
        };
        let count = 1864 >> size;
        let maximum = slice::from_raw_parts_mut(s[10] as *mut f32, 2);
        let exponent_size = slice::from_raw_parts_mut(s[11] as *mut i32, 2);
        let initialized = slice::from_raw_parts_mut(s[12] as *mut u8, 2);
        if s[1] == 11 || g.get(1) != 0 {
            let band_dir = s[8] as *const u32;
            let band_counts = s[9] as *const u32;
            let bands = slice::from_raw_parts(
                *band_dir.add(size) as *const u16,
                *band_counts.add(size) as usize,
            );
            let powers = slice::from_raw_parts(s[6] as *const f32, 156);
            for ch in 0..2 {
                if coded[ch] == 0 {
                    continue;
                }
                let exponents = slice::from_raw_parts_mut(s[14 + ch] as *mut f32, 2048);
                let mut last = 36_i32;
                let mut offset = 0;
                let mut max = 0_f32;
                for &band in bands {
                    last += vlc(g, s[4] as u32, s[5] as u32, 8) - 60;
                    if !(-60..96).contains(&last) {
                        return Err(());
                    }
                    let value = powers[(last + 60) as usize];
                    max = max.max(value);
                    let end = offset + band as usize;
                    if end > length {
                        return Err(());
                    }
                    exponents[offset..end].fill(value);
                    offset = end;
                }
                if offset != length {
                    return Err(());
                }
                maximum[ch] = max;
                exponent_size[ch] = size as i32;
                initialized[ch] = 1;
            }
        }
        let dir = slice::from_raw_parts(s[25] as *const u32, 8);
        for ch in 0..2 {
            if coded[ch] == 0 {
                continue;
            }
            if initialized[ch] == 0 {
                return Err(());
            }
            let table = if ch == 1 && stereo { 4 } else { 0 };
            let runs = dir[table + 2] as *const u16;
            let levels = dir[table + 3] as *const f32;
            let dest = slice::from_raw_parts_mut(s[18 + ch] as *mut f32, length);
            dest.fill(0.0);
            let mut i = 0_usize;
            while i < count {
                let code = vlc(g, dir[table], dir[table + 1], 9);
                if code > 1 {
                    i += *runs.add(code as usize) as usize;
                    let value = *levels.add(code as usize);
                    dest[i & (length - 1)] = if g.get(1) != 0 { value } else { -value };
                } else if code == 1 {
                    break;
                } else {
                    let level = g.get(coef_bits) as i32;
                    i += g.get(11) as usize;
                    let sign = g.get(1) as i32 - 1;
                    dest[i & (length - 1)] = ((level ^ sign) - sign) as f32;
                }
                i += 1;
            }
            if i > count || g.index > g.size {
                return Err(());
            }
        }
        // Every possible exponent is <=865964.3125. At gain>=890 the first
        // rounded multiplier already overflows float even at that denominator.
        let amplitude = if gain < 890 {
            *(s[7] as *const f64).add(gain)
        } else {
            f64::INFINITY
        };
        for ch in 0..2 {
            if coded[ch] == 0 {
                continue;
            }
            let mult = (amplitude / maximum[ch] as f64) as f32 * (2.0 / length as f32);
            let exponents = s[14 + ch] as *const f32;
            let levels = s[18 + ch] as *const f32;
            let dest = s[16 + ch] as *mut f32;
            let esize = exponent_size[ch] as usize;
            let mut i = 0;
            if esize == size {
                let mul = f32x4_splat(mult);
                while i + 4 <= count {
                    let value = f32x4_mul(
                        v128_load(levels.add(i).cast()),
                        v128_load(exponents.add(i).cast()),
                    );
                    v128_store(dest.add(i).cast(), f32x4_mul(value, mul));
                    i += 4;
                }
            }
            while i < count {
                *dest.add(i) = *levels.add(i) * *exponents.add((i << size) >> esize) * mult;
                i += 1;
            }
            slice::from_raw_parts_mut(dest.add(count), length - count).fill(0.0);
        }
        if stereo && coded[1] != 0 {
            let a = s[16] as *mut f32;
            let b = s[17] as *mut f32;
            if coded[0] == 0 {
                slice::from_raw_parts_mut(a, length).fill(0.0);
                coded[0] = 1;
            }
            for i in (0..length).step_by(4) {
                let x = v128_load(a.add(i).cast());
                let y = v128_load(b.add(i).cast());
                v128_store(a.add(i).cast(), f32x4_add(x, y));
                v128_store(b.add(i).cast(), f32x4_sub(x, y));
            }
        }
    }
    let mdct = *((s[23] as *const u32).add(size)) as *const u32;
    let output = s[20] as *mut f32;
    for ch in 0..2 {
        if coded[ch] != 0 {
            wma_imdct(mdct, s[16 + ch] as *const f32, output, 1);
        } else if !(stereo && ch == 1) {
            slice::from_raw_parts_mut(output, 4096).fill(0.0);
        }
        window(s, ch, 1024 + position - length / 2, length);
    }
    Ok(length)
}

#[inline(always)]
unsafe fn mul_add(dest: *mut f32, input: *const f32, window: *const f32, count: usize) {
    for i in (0..count).step_by(4) {
        let value = f32x4_mul(
            v128_load(input.add(i).cast()),
            v128_load(window.add(i).cast()),
        );
        v128_store(
            dest.add(i).cast(),
            f32x4_add(value, v128_load(dest.add(i).cast())),
        );
    }
}

#[inline(always)]
unsafe fn mul_reverse(dest: *mut f32, input: *const f32, window: *const f32, count: usize) {
    for i in (0..count).step_by(4) {
        let value = v128_load(window.add(count - i - 4).cast());
        let reverse = i32x4_shuffle::<3, 2, 1, 0>(value, value);
        v128_store(
            dest.add(i).cast(),
            f32x4_mul(v128_load(input.add(i).cast()), reverse),
        );
    }
}

unsafe fn window(s: &[i32], ch: usize, offset: usize, length: usize) {
    let out = (s[21 + ch] as *mut f32).add(offset);
    let input = s[20] as *const f32;
    let windows = s[24] as *const u32;
    if s[1] <= s[2] {
        mul_add(
            out,
            input,
            *windows.add((11 - s[1]) as usize) as *const f32,
            length,
        );
    } else {
        let count = 1_usize << s[2];
        let n = (length - count) / 2;
        mul_add(
            out.add(n),
            input.add(n),
            *windows.add((11 - s[2]) as usize) as *const f32,
            count,
        );
        ptr::copy_nonoverlapping(input.add(n + count), out.add(n + count), n);
    }
    let out = out.add(length);
    let input = input.add(length);
    if s[1] <= s[3] {
        mul_reverse(
            out,
            input,
            *windows.add((11 - s[1]) as usize) as *const f32,
            length,
        );
    } else {
        let count = 1_usize << s[3];
        let n = (length - count) / 2;
        ptr::copy_nonoverlapping(input, out, n);
        mul_reverse(
            out.add(n),
            input.add(n),
            *windows.add((11 - s[3]) as usize) as *const f32,
            count,
        );
        slice::from_raw_parts_mut(out.add(n + count), n).fill(0.0);
    }
}
