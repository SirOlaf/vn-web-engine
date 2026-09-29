#![no_std]

use core::arch::wasm32::*;

pub mod cbg;
pub mod dsc;
mod transition;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline]
fn average_bytes(first: u32, second: u32) -> u32 {
    (first | second).wrapping_sub(((first ^ second) & 0xfefefefe) >> 1)
}

/// Nonaliased initialized rows from 0549E0/053750. PAVGB rounds upward after
/// the vertical pair, then again after the horizontal pair, including RGB byte 4.
#[no_mangle]
pub unsafe extern "C" fn reduce_half(
    source: *const u32,
    destination: *mut u32,
    pair_width: usize,
    pair_height: usize,
    odd_column: usize,
    odd_row: usize,
) {
    let source_width = pair_width * 2 + odd_column;
    let destination_width = pair_width + odd_column;
    for row in 0..pair_height + odd_row {
        let top = source.add(row * 2 * source_width);
        // Duplicating the final odd row leaves the first upward average unchanged.
        let bottom = if row < pair_height {
            top.add(source_width)
        } else {
            top
        };
        let output = destination.add(row * destination_width);
        let mut column = 0;
        while column + 4 <= pair_width {
            let first = u8x16_avgr(
                v128_load(top.add(column * 2) as *const v128),
                v128_load(bottom.add(column * 2) as *const v128),
            );
            let second = u8x16_avgr(
                v128_load(top.add(column * 2 + 4) as *const v128),
                v128_load(bottom.add(column * 2 + 4) as *const v128),
            );
            let even = i32x4_shuffle::<0, 2, 4, 6>(first, second);
            let odd = i32x4_shuffle::<1, 3, 5, 7>(first, second);
            v128_store(output.add(column) as *mut v128, u8x16_avgr(even, odd));
            column += 4;
        }
        while column < pair_width {
            *output.add(column) = average_bytes(
                average_bytes(*top.add(column * 2), *bottom.add(column * 2)),
                average_bytes(*top.add(column * 2 + 1), *bottom.add(column * 2 + 1)),
            );
            column += 1;
        }
        if odd_column != 0 {
            *output.add(pair_width) =
                average_bytes(*top.add(pair_width * 2), *bottom.add(pair_width * 2));
        }
    }
}

#[inline]
unsafe fn affine_pixel(
    source: *const u32,
    width: i32,
    height: i32,
    stride: i32,
    x: i32,
    y: i32,
) -> u32 {
    if x >= 0 && y >= 0 && x < width && y < height {
        *source.add((y * stride + x) as usize)
    } else {
        0
    }
}

#[inline]
unsafe fn affine_channels(pixel: u32) -> v128 {
    u16x8_extend_low_u8x16(u32x4(pixel, 0, 0, 0))
}

#[inline]
unsafe fn affine_lerp(first: v128, second: v128, fraction: v128) -> v128 {
    i16x8_add(
        first,
        i16x8_shr(i16x8_mul(i16x8_sub(second, first), fraction), 4),
    )
}

#[inline]
unsafe fn affine_sample(
    source: *const u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    fixed_x: i32,
    fixed_y: i32,
    bilinear: u32,
) -> u32 {
    if bilinear == 0 {
        affine_pixel(
            source,
            source_width,
            source_height,
            source_stride,
            fixed_x.wrapping_add(0x8000) >> 16,
            fixed_y.wrapping_add(0x8000) >> 16,
        )
    } else {
        let x = fixed_x >> 16;
        let y = fixed_y >> 16;
        if x < -1 || y < -1 || x >= source_width || y >= source_height {
            0
        } else {
            let first = affine_channels(affine_pixel(
                source,
                source_width,
                source_height,
                source_stride,
                x,
                y,
            ));
            let right = affine_channels(affine_pixel(
                source,
                source_width,
                source_height,
                source_stride,
                x + 1,
                y,
            ));
            let bottom = affine_channels(affine_pixel(
                source,
                source_width,
                source_height,
                source_stride,
                x,
                y + 1,
            ));
            let diagonal = affine_channels(affine_pixel(
                source,
                source_width,
                source_height,
                source_stride,
                x + 1,
                y + 1,
            ));
            let fx = i16x8_splat(((fixed_x as u32 >> 12) & 15) as i16);
            let fy = i16x8_splat(((fixed_y as u32 >> 12) & 15) as i16);
            // Horizontal floors precede the vertical floor, exactly as in the SSE2 path.
            let result = affine_lerp(
                affine_lerp(first, right, fx),
                affine_lerp(bottom, diagonal, fx),
                fy,
            );
            u32x4_extract_lane::<0>(u8x16_narrow_i16x8(result, i16x8_splat(0)))
        }
    }
}

/// Validated, nonaliased copy branch of 052480. All source taps fit signed WORD
/// coordinates. Strides count pixels between row starts, so the host may pass packed
/// staged rows or resident rows in place without changing logical pixel addresses.
#[no_mangle]
pub unsafe extern "C" fn affine_copy(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    width: usize,
    height: usize,
    destination_stride: usize,
    mut start_x: i32,
    mut start_y: i32,
    column_x: i32,
    column_y: i32,
    row_x: i32,
    row_y: i32,
    bilinear: u32,
) {
    for row in 0..height {
        let mut fixed_x = start_x;
        let mut fixed_y = start_y;
        for column in 0..width {
            let pixel = affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                fixed_x,
                fixed_y,
                bilinear,
            );
            *destination.add(row * destination_stride + column) = pixel;
            fixed_x = fixed_x.wrapping_add(column_x);
            fixed_y = fixed_y.wrapping_add(column_y);
        }
        start_x = start_x.wrapping_add(row_x);
        start_y = start_y.wrapping_add(row_y);
    }
}

#[inline]
unsafe fn affine_dim_pixel(
    source: *const u32,
    width: i32,
    height: i32,
    stride: i32,
    x: i32,
    y: i32,
    alpha: u32,
) -> v128 {
    // Forced alpha applies only to in-bounds reads; border samples stay zero.
    affine_channels(if x >= 0 && y >= 0 && x < width && y < height {
        *source.add((y * stride + x) as usize) | alpha
    } else {
        0
    })
}

/// affine_sample with forced alpha, returning unnarrowed 16-bit channels.
#[inline]
unsafe fn affine_dim_sample(
    source: *const u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    fixed_x: i32,
    fixed_y: i32,
    bilinear: u32,
    alpha: u32,
) -> v128 {
    if bilinear == 0 {
        return affine_dim_pixel(
            source,
            source_width,
            source_height,
            source_stride,
            fixed_x.wrapping_add(0x8000) >> 16,
            fixed_y.wrapping_add(0x8000) >> 16,
            alpha,
        );
    }
    let x = fixed_x >> 16;
    let y = fixed_y >> 16;
    if x < -1 || y < -1 || x >= source_width || y >= source_height {
        return i16x8_splat(0);
    }
    let tap = |x: i32, y: i32| {
        affine_dim_pixel(
            source,
            source_width,
            source_height,
            source_stride,
            x,
            y,
            alpha,
        )
    };
    let fx = i16x8_splat(((fixed_x as u32 >> 12) & 15) as i16);
    let fy = i16x8_splat(((fixed_y as u32 >> 12) & 15) as i16);
    affine_lerp(
        affine_lerp(tap(x, y), tap(x + 1, y), fx),
        affine_lerp(tap(x, y + 1), tap(x + 1, y + 1), fx),
        fy,
    )
}

/// 052480's dimming branch (04ec00/0500e0/050410). `coefficient` is the native
/// 16-bit 256 - transparency; `alpha` is 0xff000000 when an RGB source feeds an
/// alpha destination and is ORed into every in-bounds read before interpolation.
#[no_mangle]
pub unsafe extern "C" fn affine_dim_copy(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    width: usize,
    height: usize,
    destination_stride: usize,
    mut start_x: i32,
    mut start_y: i32,
    column_x: i32,
    column_y: i32,
    row_x: i32,
    row_y: i32,
    bilinear: u32,
    alpha: u32,
    coefficient: i32,
) {
    // PMULLW keeps the low product word before PSRLW; alpha uses 256 to pass through.
    let coefficient = coefficient as i16;
    let coefficients = i16x8(coefficient, coefficient, coefficient, 256, 0, 0, 0, 0);
    for row in 0..height {
        let mut fixed_x = start_x;
        let mut fixed_y = start_y;
        for column in 0..width {
            let channels = affine_dim_sample(
                source,
                source_width,
                source_height,
                source_stride,
                fixed_x,
                fixed_y,
                bilinear,
                alpha,
            );
            let dimmed = u16x8_shr(i16x8_mul(channels, coefficients), 8);
            *destination.add(row * destination_stride + column) =
                u32x4_extract_lane::<0>(u8x16_narrow_i16x8(dimmed, i16x8_splat(0)));
            fixed_x = fixed_x.wrapping_add(column_x);
            fixed_y = fixed_y.wrapping_add(column_y);
        }
        start_x = start_x.wrapping_add(row_x);
        start_y = start_y.wrapping_add(row_y);
    }
}

#[inline]
unsafe fn affine_alpha_four(pixels: v128, old: v128, opacity: v128) -> v128 {
    let alpha = i8x16_swizzle(
        pixels,
        i8x16(3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15),
    );
    // Affine entry 127 uses numerator 128 even when overall opacity is reduced.
    let half = i8x16_add(
        u8x16_shr(alpha, 1),
        v128_and(u8x16_ge(alpha, u8x16_splat(254)), i8x16_splat(1)),
    );
    let low = u16x8_shr(i16x8_mul(u16x8_extend_low_u8x16(half), opacity), 8);
    let high = u16x8_shr(i16x8_mul(u16x8_extend_high_u8x16(half), opacity), 8);
    v128_bitselect(
        weighted_bytes(pixels, old, low, high),
        old,
        i32x4_splat(0x00ffffff),
    )
}

#[inline]
unsafe fn affine_lerp_four(first: v128, second: v128, fraction: v128) -> v128 {
    u8x16_narrow_i16x8(
        affine_lerp(
            u16x8_extend_low_u8x16(first),
            u16x8_extend_low_u8x16(second),
            fraction,
        ),
        affine_lerp(
            u16x8_extend_high_u8x16(first),
            u16x8_extend_high_u8x16(second),
            fraction,
        ),
    )
}

/// Four adjacent output pixels have four adjacent source pixels when the column
/// increment is exactly one pixel. Row increments remain independent and wrapping.
/// Border pixels retain the same scalar zero taps as the general affine kernel.
unsafe fn affine_alpha_horizontal<const BILINEAR: bool>(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    width: usize,
    height: usize,
    destination_stride: usize,
    mut start_x: i32,
    mut start_y: i32,
    row_x: i32,
    row_y: i32,
    opacity: u32,
) {
    let opacity_vector = i16x8_splat(opacity as i16);
    for row in 0..height {
        let mut fixed_x = start_x;
        let fixed_y = start_y;
        let y = if BILINEAR {
            fixed_y >> 16
        } else {
            fixed_y.wrapping_add(0x8000) >> 16
        };
        let fraction_x = i16x8_splat(((start_x as u32 >> 12) & 15) as i16);
        let fraction_y = i16x8_splat(((start_y as u32 >> 12) & 15) as i16);
        let mut column = 0;
        while column < width {
            let x = if BILINEAR {
                fixed_x >> 16
            } else {
                fixed_x.wrapping_add(0x8000) >> 16
            };
            if column + 4 <= width
                && x >= 0
                && y >= 0
                && x + 3 + (BILINEAR as i32) < source_width
                && y + (BILINEAR as i32) < source_height
            {
                let top = source.add((y * source_stride + x) as usize);
                let pixels = if BILINEAR {
                    let bottom = top.add(source_stride as usize);
                    affine_lerp_four(
                        affine_lerp_four(
                            v128_load(top as *const v128),
                            v128_load(top.add(1) as *const v128),
                            fraction_x,
                        ),
                        affine_lerp_four(
                            v128_load(bottom as *const v128),
                            v128_load(bottom.add(1) as *const v128),
                            fraction_x,
                        ),
                        fraction_y,
                    )
                } else {
                    v128_load(top as *const v128)
                };
                let target = destination.add(row * destination_stride + column);
                v128_store(
                    target as *mut v128,
                    affine_alpha_four(pixels, v128_load(target as *const v128), opacity_vector),
                );
                fixed_x = fixed_x.wrapping_add(4 * 65536);
                column += 4;
            } else {
                let pixel = affine_sample(
                    source,
                    source_width,
                    source_height,
                    source_stride,
                    fixed_x,
                    fixed_y,
                    BILINEAR as u32,
                );
                let alpha = pixel >> 25;
                let coefficient = (if alpha == 127 { 128 } else { alpha }) * opacity >> 8;
                if coefficient != 0 {
                    let target = destination.add(row * destination_stride + column);
                    *target = weighted_pixel(pixel, *target, coefficient, true);
                }
                fixed_x = fixed_x.wrapping_add(65536);
                column += 1;
            }
        }
        start_x = start_x.wrapping_add(row_x);
        start_y = start_y.wrapping_add(row_y);
    }
}

/// Four unrelated source addresses share channel arithmetic. Coordinates retain
/// signed Q16 wrapping; missing border taps use the checked one-pixel sampler.
#[inline]
unsafe fn affine_sample_four<const BILINEAR: bool>(
    source: *const u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    fixed_x: v128,
    fixed_y: v128,
) -> v128 {
    let rounding = i32x4_splat(if BILINEAR { 0 } else { 0x8000 });
    let x = i32x4_shr(i32x4_add(fixed_x, rounding), 16);
    let y = i32x4_shr(i32x4_add(fixed_y, rounding), 16);
    let interior = v128_and(
        v128_and(i32x4_ge(x, i32x4_splat(0)), i32x4_ge(y, i32x4_splat(0))),
        v128_and(
            i32x4_lt(x, i32x4_splat(source_width - BILINEAR as i32)),
            i32x4_lt(y, i32x4_splat(source_height - BILINEAR as i32)),
        ),
    );
    if !i32x4_all_true(interior) {
        return u32x4(
            affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                i32x4_extract_lane::<0>(fixed_x),
                i32x4_extract_lane::<0>(fixed_y),
                BILINEAR as u32,
            ),
            affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                i32x4_extract_lane::<1>(fixed_x),
                i32x4_extract_lane::<1>(fixed_y),
                BILINEAR as u32,
            ),
            affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                i32x4_extract_lane::<2>(fixed_x),
                i32x4_extract_lane::<2>(fixed_y),
                BILINEAR as u32,
            ),
            affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                i32x4_extract_lane::<3>(fixed_x),
                i32x4_extract_lane::<3>(fixed_y),
                BILINEAR as u32,
            ),
        );
    }
    let addresses = i32x4_add(i32x4_mul(y, i32x4_splat(source_stride)), x);
    let first = source.add(u32x4_extract_lane::<0>(addresses) as usize);
    let second = source.add(u32x4_extract_lane::<1>(addresses) as usize);
    let third = source.add(u32x4_extract_lane::<2>(addresses) as usize);
    let fourth = source.add(u32x4_extract_lane::<3>(addresses) as usize);
    let top = u32x4(*first, *second, *third, *fourth);
    if !BILINEAR {
        return top;
    }
    let right = u32x4(*first.add(1), *second.add(1), *third.add(1), *fourth.add(1));
    let stride = source_stride as usize;
    let bottom = u32x4(
        *first.add(stride),
        *second.add(stride),
        *third.add(stride),
        *fourth.add(stride),
    );
    let diagonal = u32x4(
        *first.add(stride + 1),
        *second.add(stride + 1),
        *third.add(stride + 1),
        *fourth.add(stride + 1),
    );
    let fx = v128_and(u32x4_shr(fixed_x, 12), i32x4_splat(15));
    let fy = v128_and(u32x4_shr(fixed_y, 12), i32x4_splat(15));
    let fx_low = i8x16_shuffle::<0, 1, 0, 1, 0, 1, 0, 1, 4, 5, 4, 5, 4, 5, 4, 5>(fx, fx);
    let fx_high = i8x16_shuffle::<8, 9, 8, 9, 8, 9, 8, 9, 12, 13, 12, 13, 12, 13, 12, 13>(fx, fx);
    let fy_low = i8x16_shuffle::<0, 1, 0, 1, 0, 1, 0, 1, 4, 5, 4, 5, 4, 5, 4, 5>(fy, fy);
    let fy_high = i8x16_shuffle::<8, 9, 8, 9, 8, 9, 8, 9, 12, 13, 12, 13, 12, 13, 12, 13>(fy, fy);
    // Each horizontal signed shift floors independently before the vertical one.
    u8x16_narrow_i16x8(
        affine_lerp(
            affine_lerp(
                u16x8_extend_low_u8x16(top),
                u16x8_extend_low_u8x16(right),
                fx_low,
            ),
            affine_lerp(
                u16x8_extend_low_u8x16(bottom),
                u16x8_extend_low_u8x16(diagonal),
                fx_low,
            ),
            fy_low,
        ),
        affine_lerp(
            affine_lerp(
                u16x8_extend_high_u8x16(top),
                u16x8_extend_high_u8x16(right),
                fx_high,
            ),
            affine_lerp(
                u16x8_extend_high_u8x16(bottom),
                u16x8_extend_high_u8x16(diagonal),
                fx_high,
            ),
            fy_high,
        ),
    )
}

unsafe fn affine_alpha_general<const BILINEAR: bool>(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    width: usize,
    height: usize,
    destination_stride: usize,
    mut start_x: i32,
    mut start_y: i32,
    column_x: i32,
    column_y: i32,
    row_x: i32,
    row_y: i32,
    opacity: u32,
) {
    let lanes = i32x4(0, 1, 2, 3);
    let offsets_x = i32x4_mul(lanes, i32x4_splat(column_x));
    let offsets_y = i32x4_mul(lanes, i32x4_splat(column_y));
    let step_x = i32x4_splat(column_x.wrapping_mul(4));
    let step_y = i32x4_splat(column_y.wrapping_mul(4));
    let opacity_vector = i16x8_splat(opacity as i16);
    for row in 0..height {
        let mut fixed_x = i32x4_add(i32x4_splat(start_x), offsets_x);
        let mut fixed_y = i32x4_add(i32x4_splat(start_y), offsets_y);
        let mut column = 0;
        while column + 4 <= width {
            let pixels = affine_sample_four::<BILINEAR>(
                source,
                source_width,
                source_height,
                source_stride,
                fixed_x,
                fixed_y,
            );
            let target = destination.add(row * destination_stride + column);
            v128_store(
                target as *mut v128,
                affine_alpha_four(pixels, v128_load(target as *const v128), opacity_vector),
            );
            fixed_x = i32x4_add(fixed_x, step_x);
            fixed_y = i32x4_add(fixed_y, step_y);
            column += 4;
        }
        let mut tail_x = i32x4_extract_lane::<0>(fixed_x);
        let mut tail_y = i32x4_extract_lane::<0>(fixed_y);
        while column < width {
            let pixel = affine_sample(
                source,
                source_width,
                source_height,
                source_stride,
                tail_x,
                tail_y,
                BILINEAR as u32,
            );
            let alpha = pixel >> 25;
            let coefficient = (if alpha == 127 { 128 } else { alpha }) * opacity >> 8;
            if coefficient != 0 {
                let target = destination.add(row * destination_stride + column);
                *target = weighted_pixel(pixel, *target, coefficient, true);
            }
            tail_x = tail_x.wrapping_add(column_x);
            tail_y = tail_y.wrapping_add(column_y);
            column += 1;
        }
        start_x = start_x.wrapping_add(row_x);
        start_y = start_y.wrapping_add(row_y);
    }
}

/// Initialized RGBA-over-RGB 052710 sampling. The host supplies a complete source
/// footprint and retains native Q16 coordinates relative to that footprint.
#[no_mangle]
pub unsafe extern "C" fn affine_alpha_rgb(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    source_stride: i32,
    width: usize,
    height: usize,
    destination_stride: usize,
    start_x: i32,
    start_y: i32,
    column_x: i32,
    column_y: i32,
    row_x: i32,
    row_y: i32,
    bilinear: u32,
    opacity: u32,
) {
    if column_x == 65536 && column_y == 0 {
        if bilinear == 0 {
            affine_alpha_horizontal::<false>(
                source,
                destination,
                source_width,
                source_height,
                source_stride,
                width,
                height,
                destination_stride,
                start_x,
                start_y,
                row_x,
                row_y,
                opacity,
            );
        } else {
            affine_alpha_horizontal::<true>(
                source,
                destination,
                source_width,
                source_height,
                source_stride,
                width,
                height,
                destination_stride,
                start_x,
                start_y,
                row_x,
                row_y,
                opacity,
            );
        }
        return;
    }
    if bilinear == 0 {
        affine_alpha_general::<false>(
            source,
            destination,
            source_width,
            source_height,
            source_stride,
            width,
            height,
            destination_stride,
            start_x,
            start_y,
            column_x,
            column_y,
            row_x,
            row_y,
            opacity,
        );
    } else {
        affine_alpha_general::<true>(
            source,
            destination,
            source_width,
            source_height,
            source_stride,
            width,
            height,
            destination_stride,
            start_x,
            start_y,
            column_x,
            column_y,
            row_x,
            row_y,
            opacity,
        );
    }
}

// Only nonaliased, initialized, packed rows and bounded coefficients enter this
// kernel. The host retains native checked traversal and unusual coefficient math.
#[inline]
unsafe fn weighted_bytes(source: v128, old: v128, low_weight: v128, high_weight: v128) -> v128 {
    let scale = i16x8_splat(128);
    let low = u16x8_shr(
        i16x8_add(
            i16x8_mul(u16x8_extend_low_u8x16(source), low_weight),
            i16x8_mul(u16x8_extend_low_u8x16(old), i16x8_sub(scale, low_weight)),
        ),
        7,
    );
    let high = u16x8_shr(
        i16x8_add(
            i16x8_mul(u16x8_extend_high_u8x16(source), high_weight),
            i16x8_mul(u16x8_extend_high_u8x16(old), i16x8_sub(scale, high_weight)),
        ),
        7,
    );
    u8x16_narrow_i16x8(low, high)
}

#[inline]
unsafe fn alpha_vector<const NORMAL: bool>(source: v128, old: v128, opacity: v128) -> v128 {
    let alpha = i8x16_swizzle(
        source,
        i8x16(3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15),
    );
    let mut half = u8x16_shr(alpha, 1);
    if NORMAL {
        // Native alpha/2 table replaces entries 254 and 255 with 128.
        half = i8x16_add(
            half,
            v128_and(u8x16_ge(alpha, u8x16_splat(254)), i8x16_splat(1)),
        );
    }
    let mut low = u16x8_extend_low_u8x16(half);
    let mut high = u16x8_extend_high_u8x16(half);
    if !NORMAL {
        low = u16x8_shr(i16x8_mul(low, opacity), 8);
        high = u16x8_shr(i16x8_mul(high, opacity), 8);
    }
    let mixed = weighted_bytes(source, old, low, high);
    let result = v128_bitselect(mixed, old, i32x4_splat(0x00ffffff));
    if NORMAL {
        let opaque = u32x4_ge(source, u32x4_splat(0xfe000000));
        let pair_opaque = v128_and(opaque, i32x4_shuffle::<1, 0, 3, 2>(opaque, opaque));
        // Only fully opaque pairs copy source alpha; mixed pairs retain old alpha.
        v128_bitselect(source, result, pair_opaque)
    } else {
        result
    }
}

#[inline]
fn weighted_pixel(source: u32, old: u32, weight: u32, rgb_only: bool) -> u32 {
    let mut result = if rgb_only { old & 0xff000000 } else { 0 };
    for shift in (0..if rgb_only { 24 } else { 32 }).step_by(8) {
        result |= ((((source >> shift) & 255) * weight + ((old >> shift) & 255) * (128 - weight))
            >> 7)
            << shift;
    }
    result
}

unsafe fn alpha_rows<const NORMAL: bool>(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    opacity: u32,
    source_stride: usize,
    destination_stride: usize,
) {
    let opacity_vector = i16x8_splat(opacity as i16);
    for row in 0..height {
        let source = source.add(row * source_stride);
        let destination = destination.add(row * destination_stride);
        let mut column = 0;
        while column + 3 < width {
            let pixels = v128_load(source.add(column) as *const v128);
            if v128_any_true(v128_and(pixels, u32x4_splat(0xff000000))) {
                let result = if NORMAL && u32x4_all_true(u32x4_ge(pixels, u32x4_splat(0xfe000000)))
                {
                    pixels
                } else {
                    alpha_vector::<NORMAL>(
                        pixels,
                        v128_load(destination.add(column) as *const v128),
                        opacity_vector,
                    )
                };
                v128_store(destination.add(column) as *mut v128, result);
            }
            column += 4;
        }
        if column + 1 < width {
            let pixels = v128_load64_zero(source.add(column) as *const u64);
            if v128_any_true(v128_and(pixels, u32x4_splat(0xff000000))) {
                let result = alpha_vector::<NORMAL>(
                    pixels,
                    v128_load64_zero(destination.add(column) as *const u64),
                    opacity_vector,
                );
                v128_store64_lane::<0>(result, destination.add(column) as *mut u64);
            }
            column += 2;
        }
        if column < width {
            let pixel = *source.add(column);
            let alpha = pixel >> 24;
            // Native scalar tail skips alpha zero/one and clears fully opaque alpha.
            if alpha >= 2 {
                *destination.add(column) = if NORMAL && alpha >= 254 {
                    pixel & 0x00ffffff
                } else {
                    let weight = if NORMAL {
                        alpha >> 1
                    } else {
                        ((alpha >> 1) * opacity) >> 8
                    };
                    weighted_pixel(pixel, *destination.add(column), weight, true)
                };
            }
        }
    }
}

/// Native 14003d950 / 14003cd30, with -1 selecting the nontransparent table path.
/// Strides count pixels between staged row starts; bytes between rows are never written.
#[no_mangle]
pub unsafe extern "C" fn alpha_rgb(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    opacity: i32,
    source_stride: usize,
    destination_stride: usize,
) {
    if opacity < 0 {
        alpha_rows::<true>(
            source,
            destination,
            width,
            height,
            0,
            source_stride,
            destination_stride,
        );
    } else {
        alpha_rows::<false>(
            source,
            destination,
            width,
            height,
            opacity as u32,
            source_stride,
            destination_stride,
        );
    }
}

/// Native 14003d3f0's bounded signed-word all-channel difference mix.
#[no_mangle]
pub unsafe extern "C" fn mix_all(
    source: *const u32,
    destination: *mut u32,
    pixels: usize,
    destination_weight: u32,
) {
    let weight = 128 - destination_weight;
    let weights = i16x8_splat(weight as i16);
    let mut column = 0;
    while column + 3 < pixels {
        let mixed = weighted_bytes(
            v128_load(source.add(column) as *const v128),
            v128_load(destination.add(column) as *const v128),
            weights,
            weights,
        );
        v128_store(destination.add(column) as *mut v128, mixed);
        column += 4;
    }
    while column < pixels {
        *destination.add(column) =
            weighted_pixel(*source.add(column), *destination.add(column), weight, false);
        column += 1;
    }
}

// One bounded factor's alpha-pair coefficients, populated only when encountered.
// Synchronous host calls cannot interleave while this kernel owns the workspace.
static mut MIX_ALPHA_FACTOR: u32 = u32::MAX;
static mut MIX_ALPHA_COEFFICIENTS: [u8; 256 * 256] = [0; 256 * 256];

#[inline]
fn mix_alpha_coefficient(first_alpha: u32, alpha: u32) -> u32 {
    // The measured Rosetta RCPPS seed, not exact division or fused premultiplication.
    // For factors 0..256, the input is a positive normal integer in 1..65280.
    let bits = (if alpha == 0 { 1.0 } else { alpha as f32 }).to_bits();
    let exponent = (bits >> 23) & 255;
    let index = (bits >> 12) & 2047;
    let rounded = (8192.0_f64 / (1.0 + (index as f64 + 0.5) / 2048.0) + 0.5) as u32;
    let reciprocal = (rounded as f32 / 8192.0) * f32::from_bits((254 - exponent) << 23);
    (reciprocal * ((first_alpha << 7) as f32)) as u32
}

#[inline]
unsafe fn cached_mix_alpha(coefficients: *mut u8, first: u32, second: u32, factor: u32) -> u32 {
    let entry = coefficients.add((((first >> 24) << 8) | (second >> 24)) as usize);
    if *entry == 0 {
        let first_alpha = (first >> 24) * (256 - factor);
        let alpha = first_alpha + (second >> 24) * factor;
        let value = mix_alpha_coefficient(first_alpha, alpha);
        *entry = (value + 1) as u8;
        value
    } else {
        (*entry - 1) as u32
    }
}

/// At factor zero the native reciprocal truncates to 127 for all 255 nonzero
/// first alphas, and zero for alpha zero. Second-source RGB remains observable.
unsafe fn mix_rgba_zero(
    first: *const u32,
    second: *const u32,
    destination: *mut u32,
    pixels: usize,
) {
    let weight = i16x8_splat(127);
    let rgb_mask = i32x4_splat(0x00ffffff);
    let mut index = 0;
    while index + 3 < pixels {
        let a = v128_load(first.add(index) as *const v128);
        let b = v128_load(second.add(index) as *const v128);
        let transparent = i32x4_eq(u32x4_shr(a, 24), i32x4_splat(0));
        let rgb = v128_bitselect(b, weighted_bytes(a, b, weight, weight), transparent);
        v128_store(
            destination.add(index) as *mut v128,
            v128_bitselect(rgb, a, rgb_mask),
        );
        index += 4;
    }
    while index < pixels {
        let a = *first.add(index);
        let b = *second.add(index);
        let rgb = if a >> 24 == 0 {
            b & 0x00ffffff
        } else {
            let red_blue = (((a & 0xff00ff) * 127 + (b & 0xff00ff)) >> 7) & 0xff00ff;
            let green = ((((a >> 8) & 255) * 127 + ((b >> 8) & 255)) >> 7) << 8;
            red_blue | green
        };
        *destination.add(index) = rgb | (a & 0xff000000);
        index += 1;
    }
}

/// Bounded, nonaliased native 03BEF0: coefficient truncation precedes RGB weighting.
/// Unlike fused_rgb, every output pixel is replaced, including zero-alpha pairs.
#[no_mangle]
pub unsafe extern "C" fn mix_rgba(
    first: *const u32,
    second: *const u32,
    destination: *mut u32,
    pixels: usize,
    factor: u32,
) {
    if factor == 0 {
        mix_rgba_zero(first, second, destination, pixels);
        return;
    }
    let coefficients = core::ptr::addr_of_mut!(MIX_ALPHA_COEFFICIENTS).cast::<u8>();
    if MIX_ALPHA_FACTOR != factor {
        core::ptr::write_bytes(coefficients, 0, 256 * 256);
        MIX_ALPHA_FACTOR = factor;
    }
    let inverse = 256 - factor;
    let mut index = 0;
    while index + 3 < pixels {
        let a = v128_load(first.add(index) as *const v128);
        let b = v128_load(second.add(index) as *const v128);
        // The coefficient lookup retains native reciprocal truncation. Only the
        // subsequent bounded channel weights and independent output alpha use SIMD.
        let weights = u32x4(
            cached_mix_alpha(
                coefficients,
                u32x4_extract_lane::<0>(a),
                u32x4_extract_lane::<0>(b),
                factor,
            ),
            cached_mix_alpha(
                coefficients,
                u32x4_extract_lane::<1>(a),
                u32x4_extract_lane::<1>(b),
                factor,
            ),
            cached_mix_alpha(
                coefficients,
                u32x4_extract_lane::<2>(a),
                u32x4_extract_lane::<2>(b),
                factor,
            ),
            cached_mix_alpha(
                coefficients,
                u32x4_extract_lane::<3>(a),
                u32x4_extract_lane::<3>(b),
                factor,
            ),
        );
        let rgb = weighted_bytes(
            a,
            b,
            i16x8_shuffle::<0, 0, 0, 0, 2, 2, 2, 2>(weights, weights),
            i16x8_shuffle::<4, 4, 4, 4, 6, 6, 6, 6>(weights, weights),
        );
        let alpha = i32x4_shl(
            u32x4_shr(
                i32x4_add(
                    i32x4_mul(u32x4_shr(a, 24), u32x4_splat(inverse)),
                    i32x4_mul(u32x4_shr(b, 24), u32x4_splat(factor)),
                ),
                8,
            ),
            24,
        );
        v128_store(
            destination.add(index) as *mut v128,
            v128_bitselect(rgb, alpha, i32x4_splat(0x00ffffff)),
        );
        index += 4;
    }
    while index < pixels {
        let first = *first.add(index);
        let second = *second.add(index);
        let first_alpha = (first >> 24) * inverse;
        let alpha = first_alpha + (second >> 24) * factor;
        let coefficient = cached_mix_alpha(coefficients, first, second, factor);
        let retained = 128 - coefficient;
        // The weights sum to 128, so each packed pair remains below 0x80008000.
        let red_blue =
            (((first & 0xff00ff) * coefficient + (second & 0xff00ff) * retained) >> 7) & 0xff00ff;
        let green =
            ((((first >> 8) & 255) * coefficient + ((second >> 8) & 255) * retained) >> 7) << 8;
        *destination.add(index) = red_blue | green | ((alpha >> 8) << 24);
        index += 1;
    }
}

/// Callers alternate weights (window text at its transparency, composition at zero), so a
/// few lazily filled tables stay cached, replaced round robin.
const RGBA_TABLES: usize = 4;
static mut RGBA_WEIGHTS: [u32; RGBA_TABLES] = [u32::MAX; RGBA_TABLES];
static mut RGBA_NEXT_TABLE: usize = 0;
static mut RGBA_COEFFICIENTS: [u32; RGBA_TABLES * 256 * 256] = [0; RGBA_TABLES * 256 * 256];

unsafe fn rgba_table(weight: u32) -> *mut u32 {
    let base = core::ptr::addr_of_mut!(RGBA_COEFFICIENTS).cast::<u32>();
    let weights = &mut *core::ptr::addr_of_mut!(RGBA_WEIGHTS);
    for (slot, cached) in weights.iter().enumerate() {
        if *cached == weight {
            return base.add(slot * 256 * 256);
        }
    }
    let slot = RGBA_NEXT_TABLE;
    RGBA_NEXT_TABLE = (slot + 1) % RGBA_TABLES;
    weights[slot] = weight;
    let table = base.add(slot * 256 * 256);
    core::ptr::write_bytes(table, 0, 256 * 256);
    table
}

/// The measured Rosetta RCPSS seed for a positive normal binary32 input.
#[inline]
fn rosetta_reciprocal(value: f32) -> f32 {
    let bits = value.to_bits();
    let exponent = (bits >> 23) & 255;
    let index = (bits >> 12) & 2047;
    let rounded = (8192.0_f64 / (1.0 + (index as f64 + 0.5) / 2048.0) + 0.5) as u32;
    (rounded as f32 / 8192.0) * f32::from_bits((254 - exponent) << 23)
}

/// bitmap-alpha.ts cachedRgbaPairPixel's entry: flag, truncated alpha, and both Q8 weights.
/// Every binary32 stage rounds once, as the TypeScript reference's Math.fround does.
#[inline]
fn rgba_pair_entry(source_alpha: u32, destination_alpha: u32, weight: u32) -> u32 {
    let source = source_alpha as f32 * ((256 - weight) as f32 / 256.0);
    let destination = (destination_alpha as f32 / 256.0) * (256.0 - source);
    let alpha = source + destination;
    let reciprocal = rosetta_reciprocal(if alpha == 0.0 { 1.0 } else { alpha });
    let first = ((reciprocal * source) * 256.0) as u32;
    let second = ((reciprocal * destination) * 256.0) as u32;
    0x8000_0000 | ((alpha as u32) << 18) | (second << 9) | first
}

/// bitmap-alpha.ts weightedRgb: each channel keeps the low product word before the shift.
#[inline]
fn rgba_weighted(source: u32, destination: u32, source_weight: u32, destination_weight: u32, alpha: u32) -> u32 {
    let mut pixel = alpha << 24;
    for shift in (0..24).step_by(8) {
        let product = ((source >> shift) & 255) * source_weight
            + ((destination >> shift) & 255) * destination_weight;
        pixel |= ((product & 65535) >> 8) << shift;
    }
    pixel
}

#[inline]
unsafe fn rgba_pair(coefficients: *mut u32, source: u32, destination: u32, weight: u32) -> u32 {
    let entry = coefficients.add((((source >> 24) << 8) | (destination >> 24)) as usize);
    if *entry == 0 {
        *entry = rgba_pair_entry(source >> 24, destination >> 24, weight);
    }
    let value = *entry;
    rgba_weighted(source, destination, value & 511, (value >> 9) & 511, (value >> 18) & 255)
}

/// bitmap-alpha.ts burikoAlphaTailPixel for a positive denominator (weight below 256).
#[inline]
fn rgba_tail(source: u32, destination: u32, weight: u32) -> u32 {
    let source_alpha = (source >> 24) * (256 - weight);
    let destination_alpha = ((destination >> 24) * (65536 - source_alpha)) >> 8;
    let denominator = source_alpha + destination_alpha;
    rgba_weighted(
        source,
        destination,
        (source_alpha << 8) / denominator,
        (destination_alpha << 8) / denominator,
        denominator >> 8,
    )
}

/// bitmap-alpha.ts blendInitializedRgba, native RGBA-over-RGBA 14003c720/14003ca70: MOVQ
/// pairs from the left edge, then one MOVD tail. `opaque` enables the fully opaque copies of
/// the untransparent path. Weights 0..255; strides count pixels between row starts.
#[no_mangle]
pub unsafe extern "C" fn alpha_rgba(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    weight: u32,
    opaque: u32,
    source_stride: usize,
    destination_stride: usize,
) {
    let coefficients = rgba_table(weight);
    let opaque = opaque != 0;
    for row in 0..height {
        let input = source.add(row * source_stride);
        let output = destination.add(row * destination_stride);
        let mut column = 0;
        while column + 1 < width {
            // Four pixels are two native pairs: skip wholly transparent groups and copy wholly
            // opaque ones under the opaque shortcut, exactly as each pair would.
            if column + 3 < width {
                let pixels = v128_load(input.add(column) as *const v128);
                let alphas = u32x4_shr(pixels, 24);
                if !v128_any_true(alphas) {
                    column += 4;
                    continue;
                }
                if opaque && u32x4_all_true(i32x4_eq(alphas, u32x4_splat(255))) {
                    v128_store(output.add(column) as *mut v128, pixels);
                    column += 4;
                    continue;
                }
            }
            let first = *input.add(column);
            let second = *input.add(column + 1);
            let first_alpha = first >> 24;
            let second_alpha = second >> 24;
            if first_alpha == 0 && second_alpha == 0 {
                column += 2;
                continue;
            }
            if opaque && first_alpha == 255 && second_alpha == 255 {
                *output.add(column) = first;
                *output.add(column + 1) = second;
            } else {
                let old_first = *output.add(column);
                let old_second = *output.add(column + 1);
                *output.add(column) = rgba_pair(coefficients, first, old_first, weight);
                *output.add(column + 1) = rgba_pair(coefficients, second, old_second, weight);
            }
            column += 2;
        }
        if column < width {
            let pixel = *input.add(column);
            let alpha = pixel >> 24;
            if alpha != 0 {
                *output.add(column) = if opaque && alpha == 255 {
                    pixel
                } else {
                    rgba_tail(pixel, *output.add(column), weight)
                };
            }
        }
    }
}

#[inline]
unsafe fn fused_half<const ENDPOINT: bool>(
    first: v128,
    second: v128,
    old: v128,
    first_alpha: v128,
    second_alpha: v128,
    alpha: v128,
    factor: v128,
    inverse: v128,
) -> v128 {
    // Each stage floors independently; combining these products would change pixels.
    let first_premultiplied = u16x8_shr(i16x8_mul(first, first_alpha), 8);
    let mixed = if ENDPOINT {
        first_premultiplied
    } else {
        let second_premultiplied = u16x8_shr(i16x8_mul(second, second_alpha), 8);
        u16x8_shr(
            i16x8_add(
                i16x8_mul(first_premultiplied, inverse),
                i16x8_mul(second_premultiplied, factor),
            ),
            8,
        )
    };
    let retained = u16x8_shr(i16x8_mul(old, i16x8_sub(i16x8_splat(256), alpha)), 8);
    i16x8_add(mixed, retained)
}

#[inline]
unsafe fn fused_vector<const ENDPOINT: bool>(
    first: v128,
    second: v128,
    old: v128,
    first_alpha: v128,
    second_alpha: v128,
    alpha: v128,
    factor: v128,
    inverse: v128,
) -> v128 {
    let low = fused_half::<ENDPOINT>(
        u16x8_extend_low_u8x16(first),
        u16x8_extend_low_u8x16(second),
        u16x8_extend_low_u8x16(old),
        i16x8_shuffle::<0, 0, 0, 0, 2, 2, 2, 2>(first_alpha, first_alpha),
        i16x8_shuffle::<0, 0, 0, 0, 2, 2, 2, 2>(second_alpha, second_alpha),
        i16x8_shuffle::<0, 0, 0, 0, 2, 2, 2, 2>(alpha, alpha),
        factor,
        inverse,
    );
    let high = fused_half::<ENDPOINT>(
        u16x8_extend_high_u8x16(first),
        u16x8_extend_high_u8x16(second),
        u16x8_extend_high_u8x16(old),
        i16x8_shuffle::<4, 4, 4, 4, 6, 6, 6, 6>(first_alpha, first_alpha),
        i16x8_shuffle::<4, 4, 4, 4, 6, 6, 6, 6>(second_alpha, second_alpha),
        i16x8_shuffle::<4, 4, 4, 4, 6, 6, 6, 6>(alpha, alpha),
        factor,
        inverse,
    );
    let mixed = v128_and(u8x16_narrow_i16x8(low, high), i32x4_splat(0x00ffffff));
    let zero = i32x4_eq(alpha, i32x4_splat(0));
    let pair_zero = v128_and(zero, i32x4_shuffle::<1, 0, 3, 2>(zero, zero));
    // A zero pair keeps all destination bytes. A zero pixel paired with a
    // nonzero pixel is still written, clearing its destination alpha too.
    v128_bitselect(old, mixed, pair_zero)
}

#[inline]
unsafe fn fused_alphas<const ENDPOINT: bool>(
    first: v128,
    second: v128,
    opacity: v128,
    factor: v128,
    inverse: v128,
) -> (v128, v128, v128) {
    let first_alpha = u32x4_shr(i32x4_mul(u32x4_shr(first, 24), opacity), 8);
    if ENDPOINT {
        return (first_alpha, first_alpha, first_alpha);
    }
    let second_alpha = u32x4_shr(i32x4_mul(u32x4_shr(second, 24), opacity), 8);
    let alpha = u32x4_shr(
        i32x4_add(
            i32x4_mul(first_alpha, inverse),
            i32x4_mul(second_alpha, factor),
        ),
        8,
    );
    (first_alpha, second_alpha, alpha)
}

unsafe fn fused_rows<const ENDPOINT: bool>(
    first: *const u32,
    second: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    factor: u32,
    opacity: u32,
) {
    let inverse = 256 - factor;
    let factor32 = i32x4_splat(factor as i32);
    let inverse32 = i32x4_splat(inverse as i32);
    let opacity32 = i32x4_splat(opacity as i32);
    let factor16 = i16x8_splat(factor as i16);
    let inverse16 = i16x8_splat(inverse as i16);
    for row in 0..height {
        let first = first.add(row * width);
        let second = second.add(row * width);
        let destination = destination.add(row * width);
        let mut column = 0;
        while column + 3 < width {
            let a = v128_load(first.add(column) as *const v128);
            let b = if ENDPOINT {
                a
            } else {
                v128_load(second.add(column) as *const v128)
            };
            let (first_alpha, second_alpha, alpha) =
                fused_alphas::<ENDPOINT>(a, b, opacity32, factor32, inverse32);
            if v128_any_true(alpha) {
                let result = fused_vector::<ENDPOINT>(
                    a,
                    b,
                    v128_load(destination.add(column) as *const v128),
                    first_alpha,
                    second_alpha,
                    alpha,
                    factor16,
                    inverse16,
                );
                v128_store(destination.add(column) as *mut v128, result);
            }
            column += 4;
        }
        if column + 1 < width {
            let a = v128_load64_zero(first.add(column) as *const u64);
            let b = if ENDPOINT {
                a
            } else {
                v128_load64_zero(second.add(column) as *const u64)
            };
            let (first_alpha, second_alpha, alpha) =
                fused_alphas::<ENDPOINT>(a, b, opacity32, factor32, inverse32);
            if v128_any_true(alpha) {
                let result = fused_vector::<ENDPOINT>(
                    a,
                    b,
                    v128_load64_zero(destination.add(column) as *const u64),
                    first_alpha,
                    second_alpha,
                    alpha,
                    factor16,
                    inverse16,
                );
                v128_store64_lane::<0>(result, destination.add(column) as *mut u64);
            }
            column += 2;
        }
        if column < width {
            let a = *first.add(column);
            let b = if ENDPOINT { a } else { *second.add(column) };
            let first_alpha = ((a >> 24) * opacity) >> 8;
            let second_alpha = ((b >> 24) * opacity) >> 8;
            let alpha = (first_alpha * inverse + second_alpha * factor) >> 8;
            // The odd tail is not paired with the following row's first pixel.
            if alpha != 0 {
                let old = *destination.add(column);
                let mut result = 0;
                for shift in (0..24).step_by(8) {
                    let first_premultiplied = (((a >> shift) & 255) * first_alpha) >> 8;
                    let second_premultiplied = (((b >> shift) & 255) * second_alpha) >> 8;
                    let mixed =
                        (first_premultiplied * inverse + second_premultiplied * factor) >> 8;
                    let retained = (((old >> shift) & 255) * (256 - alpha)) >> 8;
                    result |= (mixed + retained) << shift;
                }
                *destination.add(column) = result;
            }
        }
    }
}

/// Native 03C8B0/03C580's bounded, independently truncated fused RGB blend.
#[no_mangle]
pub unsafe extern "C" fn fused_rgb(
    first: *const u32,
    second: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    factor: u32,
    opacity: u32,
) {
    // At either endpoint the crossfade selects an already truncated premultiplied
    // source. It still needs the retained-destination floor and native pair skips;
    // an ordinary alpha blend is not equivalent.
    match factor {
        0 => fused_rows::<true>(first, first, destination, width, height, 0, opacity),
        256 => fused_rows::<true>(second, second, destination, width, height, 0, opacity),
        _ => fused_rows::<false>(first, second, destination, width, height, factor, opacity),
    }
}
