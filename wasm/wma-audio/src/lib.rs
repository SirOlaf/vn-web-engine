//! WMA Lossless entropy decoding, adaptive prediction and shared float transforms.
//! Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See src/formats/wma/NOTICE.
#![no_std]

use core::arch::wasm32::*;
use core::slice;
mod imdct;
mod pro;
mod standard;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

struct Bits {
    data: *const u8,
    index: u32,
    size: u32,
}
impl Bits {
    #[inline(always)]
    unsafe fn show(&self, n: u32) -> u32 {
        let p = self.data.add((self.index >> 3) as usize);
        let word = u32::from_be(core::ptr::read_unaligned(p.cast::<u32>()));
        (word << (self.index & 7)) >> (32 - n)
    }
    #[inline(always)]
    unsafe fn get(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        if n > 25 {
            return (self.get(16) << (n - 16)) | self.get(n - 16);
        }
        let p = self.data.add((self.index >> 3) as usize);
        let word = u32::from_be(core::ptr::read_unaligned(p.cast::<u32>()));
        let value = (word << (self.index & 7)) >> (32 - n);
        self.index = (self.index + n).min(self.size + 8);
        value
    }
    #[inline(always)]
    unsafe fn signed(&mut self, n: u32) -> i32 {
        (self.get(n) << (32 - n)) as i32 >> (32 - n)
    }
}

/// State: average, transient counter, update speed, sample bits, moving-average
/// scale, sample count, seekable, inter-channel flag, LMS count, residue pointer;
/// then eight (order, scale, recent, coefficients, history, updates) records.
/// All pointers are to the caller's bounded shared arena. Returns -1 on truncation.
#[no_mangle]
pub unsafe extern "C" fn wma_lossless_channel(
    state: *mut i32,
    data: *const u8,
    index: u32,
    size: u32,
) -> i32 {
    let s = slice::from_raw_parts_mut(state, 58);
    let mut g = Bits { data, index, size };
    let bits = s[3] as u32;
    let moving = s[4] as u32;
    let length = s[5] as usize;
    let seekable = s[6] != 0;
    let residues = slice::from_raw_parts_mut(s[9] as *mut i32, length);
    if g.get(1) != 0 {
        g.get(length.ilog2());
        s[1] = s[1].max(1024);
    }
    let mut average = s[0] as u32;
    let mut start = 0;
    if seekable {
        average = g.get(bits) << (moving + 1);
        residues[0] = g.signed(bits + s[7] as u32);
        start = 1;
    }
    for sample in residues.iter_mut().skip(start) {
        let mut quotient = 0_u32;
        while g.get(1) != 0 {
            quotient = quotient.wrapping_add(1);
            if g.index >= g.size {
                return -1;
            }
        }
        if quotient >= 32 {
            let n = g.get(5) + 1;
            quotient = quotient.wrapping_add(g.get(n));
        }
        let mean = average.wrapping_add(1 << moving) >> (moving + 1);
        let residue = if mean <= 1 {
            quotient
        } else {
            let n = 32 - (mean - 1).leading_zeros();
            (quotient << n).wrapping_add(g.get(n))
        };
        average = residue
            .wrapping_add(average)
            .wrapping_sub(average >> moving);
        *sample = ((residue >> 1) ^ 0_u32.wrapping_sub(residue & 1)) as i32;
    }
    s[0] = average as i32;
    let speed = if seekable { 16 } else { 8 };
    if s[2] != speed {
        for layer in 0..s[8] as usize {
            let p = 10 + layer * 6;
            let order = s[p] as usize;
            let recent = s[p + 2] as usize;
            let updates = slice::from_raw_parts_mut(s[p + 5] as *mut i16, 520);
            for update in &mut updates[recent..recent + order] {
                *update = if seekable {
                    update.wrapping_mul(2)
                } else {
                    *update / 2
                };
            }
        }
        s[2] = speed;
    }
    for layer in (0..s[8] as usize).rev() {
        let p = 10 + layer * 6;
        let order = s[p] as usize;
        let scaling = s[p + 1] as u32;
        let mut recent = s[p + 2] as usize;
        let coefs = slice::from_raw_parts_mut(s[p + 3] as *mut i16, 264);
        let updates = slice::from_raw_parts_mut(s[p + 5] as *mut i16, 520);
        let history = s[p + 4] as *mut i32;
        let range = 1_i32 << (bits - 1);
        let aligned = if bits == 16 {
            (order + 15) & !15
        } else {
            (order + 7) & !7
        };
        for sample in residues.iter_mut() {
            let residue = *sample;
            let sign = residue.signum();
            let sum = if bits == 16 {
                dot16(
                    coefs.as_mut_ptr(),
                    history.cast::<i16>().add(recent),
                    updates.as_ptr().add(recent),
                    aligned,
                    sign,
                )
            } else {
                dot32(
                    coefs.as_mut_ptr(),
                    history.add(recent),
                    updates.as_ptr().add(recent),
                    aligned,
                    sign,
                )
            };
            let pred = sum.wrapping_add((1 << scaling) >> 1) >> scaling;
            let input = residue.wrapping_add(pred);
            if recent != 0 {
                recent -= 1;
            } else {
                if bits == 16 {
                    core::ptr::copy_nonoverlapping(
                        history.cast::<i16>(),
                        history.cast::<i16>().add(order),
                        order,
                    );
                } else {
                    core::ptr::copy_nonoverlapping(history, history.add(order), order);
                }
                core::ptr::copy_nonoverlapping(
                    updates.as_ptr(),
                    updates.as_mut_ptr().add(order),
                    order,
                );
                recent = order - 1;
            }
            let value = input.clamp(-range, range - 1);
            if bits == 16 {
                *history.cast::<i16>().add(recent) = value as i16;
            } else {
                *history.add(recent) = value;
            }
            updates[recent] = (input.signum() * speed) as i16;
            updates[recent + (order >> 4)] >>= 2;
            updates[recent + (order >> 3)] >>= 1;
            // The tail starts zero and only this newly exposed entry can be live,
            // including after the history wrap copy above.
            updates[recent + order] = 0;
            *sample = input;
        }
        s[p + 2] = recent as i32;
    }
    if g.index > g.size {
        -1
    } else {
        g.index as i32
    }
}

#[inline(always)]
unsafe fn dot16(
    coefs: *mut i16,
    previous: *const i16,
    updates: *const i16,
    order: usize,
    sign: i32,
) -> i32 {
    let mut sum = i32x4_splat(0);
    let mul = i16x8_splat(sign as i16);
    for i in (0..order).step_by(8) {
        let c = v128_load(coefs.add(i).cast());
        sum = i32x4_add(sum, i32x4_dot_i16x8(c, v128_load(previous.add(i).cast())));
        v128_store(
            coefs.add(i).cast(),
            i16x8_add(c, i16x8_mul(mul, v128_load(updates.add(i).cast()))),
        );
    }
    i32x4_extract_lane::<0>(sum)
        .wrapping_add(i32x4_extract_lane::<1>(sum))
        .wrapping_add(i32x4_extract_lane::<2>(sum))
        .wrapping_add(i32x4_extract_lane::<3>(sum))
}

#[inline(always)]
unsafe fn dot32(
    coefs: *mut i16,
    previous: *const i32,
    updates: *const i16,
    order: usize,
    sign: i32,
) -> i32 {
    let mut sum = i32x4_splat(0);
    let mul = i16x8_splat(sign as i16);
    for i in (0..order).step_by(8) {
        let c = v128_load(coefs.add(i).cast());
        let low = i32x4_extend_low_i16x8(c);
        let high = i32x4_extend_high_i16x8(c);
        sum = i32x4_add(sum, i32x4_mul(low, v128_load(previous.add(i).cast())));
        sum = i32x4_add(sum, i32x4_mul(high, v128_load(previous.add(i + 4).cast())));
        v128_store(
            coefs.add(i).cast(),
            i16x8_add(c, i16x8_mul(mul, v128_load(updates.add(i).cast()))),
        );
    }
    i32x4_extract_lane::<0>(sum)
        .wrapping_add(i32x4_extract_lane::<1>(sum))
        .wrapping_add(i32x4_extract_lane::<2>(sum))
        .wrapping_add(i32x4_extract_lane::<3>(sum))
}

/// Stereo reconstruction and planar float output from Q31 samples. State layout is documented by the
/// adjacent TypeScript `finish` method; all arrays belong to this instance.
#[no_mangle]
pub unsafe extern "C" fn wma_lossless_finish(state: *mut i32) {
    let s = slice::from_raw_parts_mut(state, 26);
    let length = s[0] as usize;
    let bits = s[1];
    let a = slice::from_raw_parts_mut(s[17] as *mut i32, length);
    let b = slice::from_raw_parts_mut(s[18] as *mut i32, length);
    if s[2] == 0 {
        if s[4] != 0 {
            let order = s[10] as usize * 2;
            let scaling = s[11];
            let mut recent = s[12] as usize;
            let coefs = slice::from_raw_parts_mut(s[13] as *mut i16, 128);
            let current = slice::from_raw_parts_mut(s[14] as *mut i16, 4);
            let previous = slice::from_raw_parts_mut(s[15] as *mut i32, 128);
            let updates = slice::from_raw_parts_mut(s[16] as *mut i32, 128);
            let range = 1_i32 << (bits - 1);
            for i in 0..length {
                let mut predictions = [0_i32; 2];
                for ch in 0..2 {
                    if s[24 + ch] == 0 {
                        continue;
                    }
                    let mut pred = 0_i32;
                    for j in 0..order {
                        pred = pred.wrapping_add(
                            previous[recent + j].wrapping_mul(coefs[j + order * ch] as i32),
                        );
                    }
                    if ch == 1 {
                        pred = pred.wrapping_add(a[i].wrapping_mul(current[2] as i32));
                    }
                    pred = pred.wrapping_add((1 << scaling) >> 1) >> scaling;
                    predictions[ch] = pred;
                    if ch == 0 {
                        a[i] = a[i].wrapping_add(pred);
                    } else {
                        b[i] = b[i].wrapping_add(pred);
                    }
                }
                for ch in 0..2 {
                    let residue = if ch == 0 { a[i] } else { b[i] };
                    let sign = residue.wrapping_sub(predictions[ch]).signum();
                    if sign != 0 {
                        for j in 0..order {
                            coefs[ch * order + j] = coefs[ch * order + j]
                                .wrapping_add((sign * updates[recent + j]) as i16);
                        }
                        if ch == 1 {
                            current[2] = current[2].wrapping_add((sign * a[i].signum()) as i16);
                        }
                    }
                }
                recent -= 1;
                previous[recent] = b[i].clamp(-range, range - 1);
                updates[recent] = b[i].signum();
                recent -= 1;
                previous[recent] = a[i].clamp(-range, range - 1);
                updates[recent] = a[i].signum();
                if recent == 0 {
                    previous.copy_within(0..order, order);
                    updates.copy_within(0..order, order);
                    recent = order;
                }
            }
            s[12] = recent as i32;
        }
        if s[3] != 0 && (s[24] != 0 || s[25] != 0) {
            for i in 0..length {
                a[i] = a[i].wrapping_sub(b[i] >> 1);
                b[i] = b[i].wrapping_add(a[i]);
            }
        }
        if s[5] != 0 {
            let order = s[7] as usize;
            let scaling = s[8];
            let coefs = slice::from_raw_parts(s[9] as *const i16, order);
            for ch in 0..2 {
                let previous = slice::from_raw_parts_mut(s[19 + ch] as *mut i32, 16);
                let residues = if ch == 0 { &mut *a } else { &mut *b };
                for i in 0..length {
                    let mut pred = 0_i32;
                    for j in 0..order {
                        let value = if i <= j {
                            previous[j - i]
                        } else {
                            residues[i - j - 1]
                        };
                        pred = pred.wrapping_add((coefs[j] as i32).wrapping_mul(value));
                    }
                    residues[i] = residues[i].wrapping_add(pred >> scaling);
                }
                for j in (0..order).rev() {
                    previous[j] = if length <= j {
                        previous[j - length]
                    } else {
                        residues[length - j - 1]
                    };
                }
            }
        }
    }
    let quant = if s[2] != 0 { 1 } else { s[6] };
    let shift = s[21] as u32;
    for ch in 0..2 {
        let residues = if ch == 0 { &*a } else { &*b };
        // Output pointers already include the subframe's sample offset.
        if s[22 + ch] != 0 {
            let output = slice::from_raw_parts_mut(s[22 + ch] as *mut f32, length);
            for i in 0..length {
                output[i] = if shift >= 32 {
                    0.0
                } else {
                    ((residues[i].wrapping_mul(quant) << shift) as f32) * (1.0 / 2147483648.0)
                };
            }
        }
    }
}
