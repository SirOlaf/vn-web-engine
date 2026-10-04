use core::arch::wasm32::*;

/// Half-sample prediction of one `size` (16 or 8) block whose reference samples all lie inside
/// the plane. `u8x16_avgr` is the reference's `(a + b + 1) >> 1`.
#[inline(always)]
pub unsafe fn inside(
    src: *const u8,
    dst: *mut u8,
    stride: usize,
    hx: bool,
    hy: bool,
    size: usize,
    average: bool,
) {
    let wide = size == 16;
    let load = |p: *const u8| {
        if wide {
            v128_load(p as *const v128)
        } else {
            v128_load64_zero(p as *const u64)
        }
    };
    let two = u16x8_splat(2);
    for y in 0..size {
        let s = src.add(y * stride);
        let d = dst.add(y * stride);
        let value = match (hx, hy) {
            (false, false) => load(s),
            (false, true) => u8x16_avgr(load(s), load(s.add(stride))),
            (true, false) => u8x16_avgr(load(s), load(s.add(1))),
            (true, true) => {
                let a = load(s);
                let b = load(s.add(1));
                let c = load(s.add(stride));
                let e = load(s.add(stride + 1));
                let low = u16x8_shr(
                    i16x8_add(
                        i16x8_add(
                            i16x8_add(u16x8_extend_low_u8x16(a), u16x8_extend_low_u8x16(b)),
                            i16x8_add(u16x8_extend_low_u8x16(c), u16x8_extend_low_u8x16(e)),
                        ),
                        two,
                    ),
                    2,
                );
                if wide {
                    let high = u16x8_shr(
                        i16x8_add(
                            i16x8_add(
                                i16x8_add(u16x8_extend_high_u8x16(a), u16x8_extend_high_u8x16(b)),
                                i16x8_add(u16x8_extend_high_u8x16(c), u16x8_extend_high_u8x16(e)),
                            ),
                            two,
                        ),
                        2,
                    );
                    u8x16_narrow_i16x8(low, high)
                } else {
                    u8x16_narrow_i16x8(low, low)
                }
            }
        };
        let value = if average {
            u8x16_avgr(load(d), value)
        } else {
            value
        };
        if wide {
            v128_store(d as *mut v128, value);
        } else {
            v128_store64_lane::<0>(value, d as *mut u64);
        }
    }
}

/// The reference's per-sample edge-clamped prediction for blocks reaching outside the plane.
#[inline(never)]
pub unsafe fn clamped(
    src: *const u8,
    dst: *mut u8,
    stride: i32,
    height: i32,
    x0: i32,
    y0: i32,
    ix: i32,
    iy: i32,
    hx: bool,
    hy: bool,
    size: i32,
    average: bool,
) {
    let at = |x: i32, y: i32| *src.add((y * stride + x) as usize) as i32;
    for y in 0..size {
        let sy = (y0 + y + iy).clamp(0, height - 1);
        let sy1 = (y0 + y + iy + 1).clamp(0, height - 1);
        let target = dst.add(((y0 + y) * stride + x0) as usize);
        for x in 0..size {
            let sx = (x0 + x + ix).clamp(0, stride - 1);
            let sx1 = (x0 + x + ix + 1).clamp(0, stride - 1);
            let mut v = at(sx, sy);
            if hx && hy {
                v = (v + at(sx1, sy) + at(sx, sy1) + at(sx1, sy1) + 2) >> 2;
            } else if hx {
                v = (v + at(sx1, sy) + 1) >> 1;
            } else if hy {
                v = (v + at(sx, sy1) + 1) >> 1;
            }
            let p = target.add(x as usize);
            *p = if average {
                ((*p as i32 + v + 1) >> 1) as u8
            } else {
                v as u8
            };
        }
    }
}
