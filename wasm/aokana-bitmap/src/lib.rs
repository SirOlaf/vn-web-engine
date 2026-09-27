#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline]
unsafe fn affine_pixel(source: *const u32, width: i32, height: i32, x: i32, y: i32) -> u32 {
    if x >= 0 && y >= 0 && x < width && y < height {
        *source.add((y * width + x) as usize)
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
    fixed_x: i32,
    fixed_y: i32,
    bilinear: u32,
) -> u32 {
    if bilinear == 0 {
        affine_pixel(
            source,
            source_width,
            source_height,
            fixed_x.wrapping_add(0x8000) >> 16,
            fixed_y.wrapping_add(0x8000) >> 16,
        )
    } else {
        let x = fixed_x >> 16;
        let y = fixed_y >> 16;
        if x < -1 || y < -1 || x >= source_width || y >= source_height {
            0
        } else {
            let first = affine_channels(affine_pixel(source, source_width, source_height, x, y));
            let right =
                affine_channels(affine_pixel(source, source_width, source_height, x + 1, y));
            let bottom =
                affine_channels(affine_pixel(source, source_width, source_height, x, y + 1));
            let diagonal = affine_channels(affine_pixel(
                source,
                source_width,
                source_height,
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
/// coordinates; the host packs rows without changing their logical pixel addresses.
#[no_mangle]
pub unsafe extern "C" fn affine_copy(
    source: *const u32,
    destination: *mut u32,
    source_width: i32,
    source_height: i32,
    width: usize,
    height: usize,
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
                fixed_x,
                fixed_y,
                bilinear,
            );
            *destination.add(row * width + column) = pixel;
            fixed_x = fixed_x.wrapping_add(column_x);
            fixed_y = fixed_y.wrapping_add(column_y);
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
    width: usize,
    height: usize,
    mut start_x: i32,
    mut start_y: i32,
    column_x: i32,
    column_y: i32,
    row_x: i32,
    row_y: i32,
    bilinear: u32,
    opacity: u32,
) {
    for row in 0..height {
        let mut fixed_x = start_x;
        let mut fixed_y = start_y;
        for column in 0..width {
            let pixel = affine_sample(
                source,
                source_width,
                source_height,
                fixed_x,
                fixed_y,
                bilinear,
            );
            let alpha = pixel >> 25;
            let coefficient = (if alpha == 127 { 128 } else { alpha }) * opacity >> 8;
            if coefficient != 0 {
                let target = destination.add(row * width + column);
                let old = *target;
                let retained = 128 - coefficient;
                let red_blue = (((pixel & 0xff00ff) * coefficient + (old & 0xff00ff) * retained)
                    >> 7)
                    & 0xff00ff;
                let green = ((((pixel >> 8) & 255) * coefficient + ((old >> 8) & 255) * retained)
                    >> 7)
                    << 8;
                *target = (old & 0xff000000) | red_blue | green;
            }
            // Zero-coefficient stores would reproduce old bytes. With initialized,
            // nonaliased buffers, leaving them in place also preserves zero pairs/tails.
            fixed_x = fixed_x.wrapping_add(column_x);
            fixed_y = fixed_y.wrapping_add(column_y);
        }
        start_x = start_x.wrapping_add(row_x);
        start_y = start_y.wrapping_add(row_y);
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
) {
    let opacity_vector = i16x8_splat(opacity as i16);
    for row in 0..height {
        let source = source.add(row * width);
        let destination = destination.add(row * width);
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
#[no_mangle]
pub unsafe extern "C" fn alpha_rgb(
    source: *const u32,
    destination: *mut u32,
    width: usize,
    height: usize,
    opacity: i32,
) {
    if opacity < 0 {
        alpha_rows::<true>(source, destination, width, height, 0);
    } else {
        alpha_rows::<false>(source, destination, width, height, opacity as u32);
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
    let coefficients = core::ptr::addr_of_mut!(MIX_ALPHA_COEFFICIENTS).cast::<u8>();
    if MIX_ALPHA_FACTOR != factor {
        core::ptr::write_bytes(coefficients, 0, 256 * 256);
        MIX_ALPHA_FACTOR = factor;
    }
    let inverse = 256 - factor;
    for index in 0..pixels {
        let first = *first.add(index);
        let second = *second.add(index);
        let first_alpha = (first >> 24) * inverse;
        let alpha = first_alpha + (second >> 24) * factor;
        let key = (((first >> 24) << 8) | (second >> 24)) as usize;
        let entry = coefficients.add(key);
        let coefficient = if *entry == 0 {
            let value = mix_alpha_coefficient(first_alpha, alpha);
            *entry = (value + 1) as u8;
            value
        } else {
            (*entry - 1) as u32
        };
        let retained = 128 - coefficient;
        // The weights sum to 128, so each packed pair remains below 0x80008000.
        let red_blue =
            (((first & 0xff00ff) * coefficient + (second & 0xff00ff) * retained) >> 7) & 0xff00ff;
        let green =
            ((((first >> 8) & 255) * coefficient + ((second >> 8) & 255) * retained) >> 7) << 8;
        *destination.add(index) = red_blue | green | ((alpha >> 8) << 24);
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
