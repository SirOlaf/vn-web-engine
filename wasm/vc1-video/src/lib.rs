//! Progressive VC-1 pixel kernels, derived from FFmpeg 7.1.1.
//! LGPL-2.1-or-later; see src/formats/vc1/NOTICE and LICENSE for copyright and terms.
//! Host-owned planes and coefficient buffers live in this instance's linear memory.
#![no_std]
use core::arch::wasm32::*;
mod bits;
mod block_support;
mod blocks;
mod tables;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline(always)]
fn clip(x: i32) -> u8 {
    x.clamp(0, 255) as u8
}
#[inline(always)]
fn tx8(x: [i32; 8], round: i32, shift: u32, bias: i32) -> [i32; 8] {
    let a = 12 * (x[0] + x[4]) + round;
    let b = 12 * (x[0] - x[4]) + round;
    let c = 16 * x[2] + 6 * x[6];
    let d = 6 * x[2] - 16 * x[6];
    let e = 16 * x[1] + 15 * x[3] + 9 * x[5] + 4 * x[7];
    let f = 15 * x[1] - 4 * x[3] - 16 * x[5] - 9 * x[7];
    let g = 9 * x[1] - 16 * x[3] + 4 * x[5] + 15 * x[7];
    let h = 4 * x[1] - 9 * x[3] + 15 * x[5] - 16 * x[7];
    [
        (a + c + e) >> shift,
        (b + d + f) >> shift,
        (b - d + g) >> shift,
        (a - c + h) >> shift,
        (a - c - h + bias) >> shift,
        (b - d - g + bias) >> shift,
        (b + d - f + bias) >> shift,
        (a + c - e + bias) >> shift,
    ]
}
#[inline(always)]
fn tx4(x: [i32; 4], round: i32, shift: u32) -> [i32; 4] {
    let a = 17 * (x[0] + x[2]) + round;
    let b = 17 * (x[0] - x[2]) + round;
    let c = 22 * x[1] + 10 * x[3];
    let d = 22 * x[3] - 10 * x[1];
    [
        (a + c) >> shift,
        (b - d) >> shift,
        (b + d) >> shift,
        (a - c) >> shift,
    ]
}
#[inline(always)]
unsafe fn read8(p: *const i16, step: usize) -> [i32; 8] {
    let mut x = [0; 8];
    for i in 0..8 {
        x[i] = *p.add(i * step) as i32;
    }
    x
}
#[inline(always)]
unsafe fn read4(p: *const i16, step: usize) -> [i32; 4] {
    let mut x = [0; 4];
    for i in 0..4 {
        x[i] = *p.add(i * step) as i32;
    }
    x
}
#[inline(always)]
fn mul(v: v128, n: i32) -> v128 {
    i32x4_mul(v, i32x4_splat(n))
}
#[inline(always)]
fn tx8v(x: [v128; 8], round: i32, shift: u32, bias: i32) -> [v128; 8] {
    let a = i32x4_add(mul(i32x4_add(x[0], x[4]), 12), i32x4_splat(round));
    let b = i32x4_add(mul(i32x4_sub(x[0], x[4]), 12), i32x4_splat(round));
    let c = i32x4_add(mul(x[2], 16), mul(x[6], 6));
    let d = i32x4_sub(mul(x[2], 6), mul(x[6], 16));
    let e = i32x4_add(
        i32x4_add(mul(x[1], 16), mul(x[3], 15)),
        i32x4_add(mul(x[5], 9), mul(x[7], 4)),
    );
    let f = i32x4_sub(
        i32x4_sub(mul(x[1], 15), mul(x[3], 4)),
        i32x4_add(mul(x[5], 16), mul(x[7], 9)),
    );
    let g = i32x4_add(
        i32x4_sub(mul(x[1], 9), mul(x[3], 16)),
        i32x4_add(mul(x[5], 4), mul(x[7], 15)),
    );
    let h = i32x4_sub(
        i32x4_add(mul(x[1], 4), mul(x[5], 15)),
        i32x4_add(mul(x[3], 9), mul(x[7], 16)),
    );
    let ac = i32x4_add(a, c);
    let bd = i32x4_add(b, d);
    let bm = i32x4_sub(b, d);
    let am = i32x4_sub(a, c);
    let r = i32x4_splat(bias);
    [
        i32x4_shr(i32x4_add(ac, e), shift),
        i32x4_shr(i32x4_add(bd, f), shift),
        i32x4_shr(i32x4_add(bm, g), shift),
        i32x4_shr(i32x4_add(am, h), shift),
        i32x4_shr(i32x4_add(i32x4_sub(am, h), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(bm, g), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(bd, f), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(ac, e), r), shift),
    ]
}
/// Four independent columns, with signed-16 narrowing at the same pass boundary as JS.
#[no_mangle]
pub unsafe extern "C" fn vc1_tx8(block: *mut i16) {
    let mut tmp = [0i16; 64];
    for col in [0, 4] {
        let mut x = [i32x4_splat(0); 8];
        for row in 0..8 {
            x[row] = i32x4_extend_low_i16x8(v128_load64_zero(block.add(row * 8 + col).cast()));
        }
        let y = tx8v(x, 4, 3, 0);
        for k in 0..8 {
            tmp[col * 8 + k] = i32x4_extract_lane::<0>(y[k]) as i16;
            tmp[(col + 1) * 8 + k] = i32x4_extract_lane::<1>(y[k]) as i16;
            tmp[(col + 2) * 8 + k] = i32x4_extract_lane::<2>(y[k]) as i16;
            tmp[(col + 3) * 8 + k] = i32x4_extract_lane::<3>(y[k]) as i16;
        }
    }
    for col in [0, 4] {
        let mut x = [i32x4_splat(0); 8];
        for row in 0..8 {
            x[row] =
                i32x4_extend_low_i16x8(v128_load64_zero(tmp.as_ptr().add(row * 8 + col).cast()));
        }
        let y = tx8v(x, 64, 7, 1);
        for row in 0..8 {
            let p = block.add(row * 8 + col);
            // Cast rather than saturate: coefficient storage uses signed-16 wrapping.
            *p = i32x4_extract_lane::<0>(y[row]) as i16;
            *p.add(1) = i32x4_extract_lane::<1>(y[row]) as i16;
            *p.add(2) = i32x4_extract_lane::<2>(y[row]) as i16;
            *p.add(3) = i32x4_extract_lane::<3>(y[row]) as i16;
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_tx_small(
    dst: *mut u8,
    stride: usize,
    block: *mut i16,
    width: usize,
    height: usize,
) {
    for row in 0..height {
        if width == 8 {
            let y = tx8(read8(block.add(row * 8), 1), 4, 3, 0);
            for i in 0..8 {
                *block.add(row * 8 + i) = y[i] as i16;
            }
        } else {
            let y = tx4(read4(block.add(row * 8), 1), 4, 3);
            for i in 0..4 {
                *block.add(row * 8 + i) = y[i] as i16;
            }
        }
    }
    for col in 0..width {
        if height == 8 {
            let y = tx8(read8(block.add(col), 8), 64, 7, 1);
            for row in 0..8 {
                let p = dst.add(row * stride + col);
                *p = clip(*p as i32 + y[row]);
            }
        } else {
            let y = tx4(read4(block.add(col), 8), 64, 7);
            for row in 0..4 {
                let p = dst.add(row * stride + col);
                *p = clip(*p as i32 + y[row]);
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_tx_dc(
    dst: *mut u8,
    stride: usize,
    width: usize,
    height: usize,
    mut dc: i32,
) {
    if width == 8 {
        dc = (3 * dc + 1) >> 1;
    } else {
        dc = (17 * dc + 4) >> 3;
    }
    dc = if height == 8 {
        if width == 8 {
            (3 * dc + 16) >> 5
        } else {
            (12 * dc + 64) >> 7
        }
    } else {
        (17 * dc + 64) >> 7
    };
    let value = i16x8_splat(dc as i16);
    for row in 0..height {
        let p = dst.add(row * stride);
        let old = u16x8_extend_low_u8x16(v128_load64_zero(p.cast()));
        let sum = i16x8_add_sat(old, value);
        let packed = u8x16_narrow_i16x8(sum, i16x8_splat(0));
        if width == 8 {
            v128_store64_lane::<0>(packed, p.cast());
        } else {
            v128_store32_lane::<0>(packed, p.cast());
        }
    }
}
/// mode 0: unsigned put; 1: signed put; 2: add to prediction.
#[no_mangle]
pub unsafe extern "C" fn vc1_pixels(block: *const i16, dst: *mut u8, stride: usize, mode: i32) {
    for row in 0..8 {
        let mut value = v128_load(block.add(row * 8).cast());
        let p = dst.add(row * stride);
        if mode == 1 {
            value = i16x8_add_sat(value, i16x8_splat(128));
        }
        if mode == 2 {
            value = i16x8_add_sat(value, u16x8_extend_low_u8x16(v128_load64_zero(p.cast())));
        }
        v128_store64_lane::<0>(u8x16_narrow_i16x8(value, i16x8_splat(0)), p.cast());
    }
}
#[inline(always)]
unsafe fn line(p: *mut u8, stride: isize, pq: i32) -> bool {
    let at = |n: isize| *p.offset(n * stride) as i32;
    let m2 = at(-2);
    let m1 = at(-1);
    let p0 = at(0);
    let p1 = at(1);
    let raw = (2 * (m2 - p1) - 5 * (m1 - p0) + 4) >> 3;
    let a0 = raw.abs();
    if a0 < pq {
        let a1 = ((2 * (at(-4) - m1) - 5 * (at(-3) - m2) + 4) >> 3).abs();
        let a2 = ((2 * (p0 - at(3)) - 5 * (p1 - at(2)) + 4) >> 3).abs();
        if a1 < a0 || a2 < a0 {
            let c = (m1 - p0).abs() >> 1;
            if c != 0 {
                let dr = 5 * (a1.min(a2) - a0);
                let sign = (dr >> 31) ^ (raw >> 31);
                if (sign ^ ((m1 - p0) >> 31)) == 0 {
                    let d = (dr.abs() >> 3).min(c);
                    let d = (d ^ sign) - sign;
                    *p.offset(-stride) = clip(m1 - d);
                    *p = clip(p0 + d);
                }
                return true;
            }
        }
    }
    false
}
#[inline(always)]
unsafe fn loop_edge<const H: bool, const N: usize>(p: *mut u8, pitch: isize, pq: i32) {
    let step = if H { pitch } else { 1 };
    let across = if H { 1 } else { pitch };
    for i in (0..N).step_by(4) {
        let q = p.offset(i as isize * step);
        if line(q.offset(2 * step), across, pq) {
            line(q, across, pq);
            line(q.offset(step), across, pq);
            line(q.offset(3 * step), across, pq);
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_loop(p: *mut u8, step: isize, stride: isize, length: usize, pq: i32) {
    // Direction and edge length are fixed at each VC-1 call site. Specializing them
    // removes generic address calculations and lets LLVM unroll the 4-pixel groups.
    if step == 1 {
        match length {
            4 => loop_edge::<false, 4>(p, stride, pq),
            8 => loop_edge::<false, 8>(p, stride, pq),
            _ => loop_edge::<false, 16>(p, stride, pq),
        }
    } else {
        match length {
            4 => loop_edge::<true, 4>(p, step, pq),
            8 => loop_edge::<true, 8>(p, step, pq),
            _ => loop_edge::<true, 16>(p, step, pq),
        }
    }
}
#[inline(always)]
unsafe fn load_bytes(p: *const u8) -> v128 {
    i32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(p.cast())))
}
#[inline(always)]
unsafe fn write_bytes(p: *mut u8, mut value: v128, avg: bool) {
    value = i32x4_min(i32x4_max(value, i32x4_splat(0)), i32x4_splat(255));
    if avg {
        value = i32x4_shr(
            i32x4_add(i32x4_add(value, load_bytes(p)), i32x4_splat(1)),
            1,
        );
    }
    let packed = u8x16_narrow_i16x8(i16x8_narrow_i32x4(value, i32x4_splat(0)), i16x8_splat(0));
    v128_store32_lane::<0>(packed, p.cast());
}
#[inline(always)]
fn filter(a: v128, b: v128, c: v128, d: v128, mode: i32) -> v128 {
    match mode {
        1 => i32x4_sub(
            i32x4_add(mul(b, 53), mul(c, 18)),
            i32x4_add(mul(a, 4), mul(d, 3)),
        ),
        2 => i32x4_sub(mul(i32x4_add(b, c), 9), i32x4_add(a, d)),
        3 => i32x4_sub(
            i32x4_add(mul(b, 18), mul(c, 53)),
            i32x4_add(mul(a, 3), mul(d, 4)),
        ),
        _ => b,
    }
}
#[inline(always)]
unsafe fn filter_bytes(p: *const u8, step: isize, mode: i32) -> v128 {
    filter(
        load_bytes(p.offset(-step)),
        load_bytes(p),
        load_bytes(p.offset(step)),
        load_bytes(p.offset(2 * step)),
        mode,
    )
}
/// Integral motion needs no interpolation or clipping. Reference and output planes
/// are disjoint; averaging is the unsigned rounded average of corresponding bytes.
#[inline(always)]
unsafe fn copy_block(dst: *mut u8, src: *const u8, stride: usize, w: usize, h: usize, avg: bool) {
    for row in 0..h {
        let d = dst.add(row * stride);
        let s = src.add(row * stride);
        if w == 16 {
            let mut v = v128_load(s.cast());
            if avg {
                v = u8x16_avgr(v, v128_load(d.cast()));
            }
            v128_store(d.cast(), v);
        } else if w == 8 {
            let mut v = v128_load64_zero(s.cast());
            if avg {
                v = u8x16_avgr(v, v128_load64_zero(d.cast()));
            }
            v128_store64_lane::<0>(v, d.cast());
        } else {
            for col in (0..w).step_by(4) {
                let mut v = v128_load32_zero(s.add(col).cast());
                if avg {
                    v = u8x16_avgr(v, v128_load32_zero(d.add(col).cast()));
                }
                v128_store32_lane::<0>(v, d.add(col).cast());
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_mspel(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    n: usize,
    hm: i32,
    vm: i32,
    rnd: i32,
    avg: bool,
) {
    if hm == 0 && vm == 0 {
        copy_block(dst, src, stride, n, n, avg);
        return;
    }
    if hm != 0 && vm != 0 {
        let shifts = [0, 5, 1, 5];
        let shift = (shifts[hm as usize] + shifts[vm as usize]) >> 1;
        let r = i32x4_splat((1 << (shift - 1)) + rnd - 1);
        let width = n + 3;
        let mut tmp = [0i16; 19 * 16];
        for row in 0..n {
            for col in (0..n).step_by(4) {
                let p = src.offset((row * stride + col) as isize - 1);
                let value = i32x4_shr(i32x4_add(filter_bytes(p, stride as isize, vm), r), shift);
                let value = i16x8_narrow_i32x4(value, i32x4_splat(0));
                v128_store64_lane::<0>(value, tmp.as_mut_ptr().add(row * width + col).cast());
            }
            // Three border columns remain. Scalar loads keep the read inside the
            // 11- or 19-pixel emulated source block supplied by the host.
            for col in n..width {
                let p = src.offset((row * stride + col) as isize - 1);
                let a = *p.offset(-(stride as isize)) as i32;
                let b = *p as i32;
                let c = *p.add(stride) as i32;
                let d = *p.add(2 * stride) as i32;
                let value = match vm {
                    1 => -4 * a + 53 * b + 18 * c - 3 * d,
                    2 => -a + 9 * b + 9 * c - d,
                    _ => -3 * a + 18 * b + 53 * c - 4 * d,
                };
                tmp[row * width + col] = ((value + i32x4_extract_lane::<0>(r)) >> shift) as i16;
            }
        }
        for row in 0..n {
            for col in (0..n).step_by(4) {
                let p = tmp.as_ptr().add(row * width + col + 1);
                let load = |q: *const i16| i32x4_extend_low_i16x8(v128_load64_zero(q.cast()));
                let v = filter(load(p.sub(1)), load(p), load(p.add(1)), load(p.add(2)), hm);
                write_bytes(
                    dst.add(row * stride + col),
                    i32x4_shr(i32x4_add(v, i32x4_splat(64 - rnd)), 7),
                    avg,
                );
            }
        }
    } else {
        for row in 0..n {
            for col in (0..n).step_by(4) {
                let p = src.add(row * stride + col);
                let mode = if vm != 0 { vm } else { hm };
                let value = if mode == 0 {
                    load_bytes(p)
                } else {
                    let r = if vm != 0 { 1 - rnd } else { rnd };
                    let v = filter_bytes(p, if vm != 0 { stride as isize } else { 1 }, mode);
                    let shift = if mode == 2 { 4 } else { 6 };
                    let round = if mode == 2 { 8 - r } else { 32 - r };
                    i32x4_shr(i32x4_add(v, i32x4_splat(round)), shift)
                };
                // Clip before averaging, matching the reference's put/avg interpolation variants.
                let value = i32x4_min(i32x4_max(value, i32x4_splat(0)), i32x4_splat(255));
                write_bytes(dst.add(row * stride + col), value, avg);
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_hpel(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    n: usize,
    dxy: i32,
    no_rnd: bool,
    avg: bool,
) {
    if dxy == 0 {
        copy_block(dst, src, stride, n, n, avg);
        return;
    }
    let r2 = i32x4_splat(if no_rnd { 0 } else { 1 });
    let r4 = i32x4_splat(if no_rnd { 1 } else { 2 });
    for row in 0..n {
        for col in (0..n).step_by(4) {
            let p = src.add(row * stride + col);
            let a = load_bytes(p);
            let v = match dxy {
                1 => i32x4_shr(i32x4_add(i32x4_add(a, load_bytes(p.add(1))), r2), 1),
                2 => i32x4_shr(i32x4_add(i32x4_add(a, load_bytes(p.add(stride))), r2), 1),
                3 => i32x4_shr(
                    i32x4_add(
                        i32x4_add(a, load_bytes(p.add(1))),
                        i32x4_add(
                            i32x4_add(load_bytes(p.add(stride)), load_bytes(p.add(stride + 1))),
                            r4,
                        ),
                    ),
                    2,
                ),
                _ => a,
            };
            write_bytes(dst.add(row * stride + col), v, avg);
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_chroma(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    w: usize,
    h: usize,
    x: i32,
    y: i32,
    no_rnd: bool,
    avg: bool,
) {
    if x == 0 && y == 0 {
        copy_block(dst, src, stride, w, h, avg);
        return;
    }
    let a = (8 - x) * (8 - y);
    let b = x * (8 - y);
    let c = (8 - x) * y;
    let d = x * y;
    let r = i32x4_splat(if no_rnd { 28 } else { 32 });
    for row in 0..h {
        for col in (0..w).step_by(4) {
            let p = src.add(row * stride + col);
            let v = i32x4_add(
                i32x4_add(mul(load_bytes(p), a), mul(load_bytes(p.add(1)), b)),
                i32x4_add(
                    mul(load_bytes(p.add(stride)), c),
                    mul(load_bytes(p.add(stride + 1)), d),
                ),
            );
            write_bytes(
                dst.add(row * stride + col),
                i32x4_shr(i32x4_add(v, r), 6),
                avg,
            );
        }
    }
}
