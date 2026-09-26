#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// Host validates and copies all spans before entry. No imports, allocator, host
// callbacks, relaxed SIMD, or fused arithmetic are used by this kernel.
#[inline]
unsafe fn texel(bytes: *const u8, offset: usize, normalized: *const f32) -> v128 {
    f32x4(
        *normalized.add(*bytes.add(offset + 2) as usize),
        *normalized.add(*bytes.add(offset + 1) as usize),
        *normalized.add(*bytes.add(offset) as usize),
        0.0,
    )
}

#[inline]
unsafe fn horizontal(
    source: *const u8,
    width: i32,
    height: i32,
    pitch: usize,
    source_x: *const i32,
    fraction_x: *const f32,
    columns: usize,
    y: i32,
    output: *mut v128,
    normalized: *const f32,
) {
    let zero = f32x4_splat(0.0);
    if y < 0 || y >= height {
        for x in 0..columns {
            v128_store(output.add(x), zero);
        }
        return;
    }
    let row = y as usize * pitch;
    for column in 0..columns {
        let x = *source_x.add(column);
        let a = if x >= 0 && x < width {
            texel(source, row + x as usize * 4, normalized)
        } else {
            zero
        };
        let fraction = *fraction_x.add(column);
        if fraction == 0.0 {
            v128_store(output.add(column), a);
            continue;
        }
        let b = if x + 1 >= 0 && x + 1 < width {
            texel(source, row + (x + 1) as usize * 4, normalized)
        } else {
            zero
        };
        let value = f32x4_add(
            f32x4_mul(b, f32x4_splat(fraction)),
            f32x4_mul(a, f32x4_splat(1.0 - fraction)),
        );
        v128_store(output.add(column), value);
    }
}

/// Binary32 separable linear RGB, transparent-black borders, RGBA8 output with alpha 255.
/// Positions are integral; fractions and the normalization table come from the host's
/// exact coordinate/numerical profile. Scratch rows each hold `columns` v128 values.
#[no_mangle]
pub unsafe extern "C" fn linear_rgb(
    source: *const u8,
    width: i32,
    height: i32,
    pitch: usize,
    source_x: *const i32,
    fraction_x: *const f32,
    source_y: *const i32,
    fraction_y: *const f32,
    columns: usize,
    rows: usize,
    mut top: *mut v128,
    mut bottom: *mut v128,
    normalized: *const f32,
    output: *mut u32,
) {
    let mut top_y = i32::MIN;
    let mut bottom_y = i32::MIN;
    for row in 0..rows {
        let y = *source_y.add(row);
        if top_y != y {
            if bottom_y == y {
                core::mem::swap(&mut top, &mut bottom);
                core::mem::swap(&mut top_y, &mut bottom_y);
            } else {
                horizontal(
                    source, width, height, pitch, source_x, fraction_x, columns, y, top, normalized,
                );
                top_y = y;
            }
        }
        if bottom_y != y + 1 {
            horizontal(
                source,
                width,
                height,
                pitch,
                source_x,
                fraction_x,
                columns,
                y + 1,
                bottom,
                normalized,
            );
            bottom_y = y + 1;
        }
        let fraction = *fraction_y.add(row);
        let fy = f32x4_splat(fraction);
        let one_minus_y = f32x4_splat(1.0 - fraction);
        for column in 0..columns {
            let a = v128_load(top.add(column));
            let color = if fraction == 0.0 {
                a
            } else {
                f32x4_add(
                    f32x4_mul(v128_load(bottom.add(column)), fy),
                    f32x4_mul(a, one_minus_y),
                )
            };
            // Uint8ClampedArray's ties-to-even rounding after the binary32 *255.
            let words = i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(color, f32x4_splat(255.0))));
            let halves = i16x8_narrow_i32x4(words, words);
            let bytes = u8x16_narrow_i16x8(halves, halves);
            *output.add(row * columns + column) = u32x4_extract_lane::<0>(bytes) | 0xff000000;
        }
    }
}
