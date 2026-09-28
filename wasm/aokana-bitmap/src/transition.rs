use core::arch::wasm32::*;
use core::ptr::addr_of_mut;

// Mask-byte actions for 04BC40/04B860/04BA70/04B660. The host derives every
// entry from the exact scalar coverage, bias and coefficient-table rules.
// Other entries are signed coefficients k: delta = ((difference << 4) * k) >> 16.
const COPY: i32 = 0x10000;
const SKIP: i32 = 0x20000;

static mut TABLE: [i32; 256] = [0; 256];

/// Host-written action table indexed by mask byte.
#[no_mangle]
pub unsafe extern "C" fn transition_table() -> *mut i32 {
    addr_of_mut!(TABLE) as *mut i32
}

#[inline]
unsafe fn transition_half(source: v128, old: v128, coefficients: v128) -> v128 {
    // Differences are at most 4080 in magnitude, so products fit 32 bits and
    // arithmetic shifts reproduce the host floor division.
    let difference = i16x8_shl(i16x8_sub(source, old), 4);
    let delta = i16x8_narrow_i32x4(
        i32x4_shr(i32x4_extmul_low_i16x8(difference, coefficients), 16),
        i32x4_shr(i32x4_extmul_high_i16x8(difference, coefficients), 16),
    );
    i16x8_add(old, delta)
}

#[inline]
unsafe fn transition_vector(source: v128, old: v128, entries: v128) -> v128 {
    let low = transition_half(
        u16x8_extend_low_u8x16(source),
        u16x8_extend_low_u8x16(old),
        i16x8_shuffle::<0, 0, 0, 0, 2, 2, 2, 2>(entries, entries),
    );
    let high = transition_half(
        u16x8_extend_high_u8x16(source),
        u16x8_extend_high_u8x16(old),
        i16x8_shuffle::<4, 4, 4, 4, 6, 6, 6, 6>(entries, entries),
    );
    // Signed narrowing saturates each channel; blended pixels retain old alpha.
    let mixed = v128_bitselect(u8x16_narrow_i16x8(low, high), old, i32x4_splat(0x00ffffff));
    let copied = v128_bitselect(source, mixed, i32x4_eq(entries, i32x4_splat(COPY)));
    v128_bitselect(old, copied, i32x4_eq(entries, i32x4_splat(SKIP)))
}

#[inline]
fn transition_pixel(pixel: u32, old: u32, coefficient: i32) -> u32 {
    let mut result = old & 0xff000000;
    for shift in (0..24).step_by(8) {
        let previous = ((old >> shift) & 255) as i32;
        let delta = (((((pixel >> shift) & 255) as i32 - previous) << 4) * coefficient) >> 16;
        result |= ((previous + delta).clamp(0, 255) as u32) << shift;
    }
    result
}

/// Separate, initialized RGB32 source/destination rows and an 8-bit mask, all packed.
#[no_mangle]
pub unsafe extern "C" fn transition_rgb(
    source: *const u32,
    destination: *mut u32,
    mask: *const u8,
    width: usize,
    height: usize,
) {
    let table = addr_of_mut!(TABLE) as *const i32;
    let skip = i32x4_splat(SKIP);
    for row in 0..height {
        let source = source.add(row * width);
        let destination = destination.add(row * width);
        let mask = mask.add(row * width);
        let mut column = 0;
        while column + 3 < width {
            let entries = i32x4(
                *table.add(*mask.add(column) as usize),
                *table.add(*mask.add(column + 1) as usize),
                *table.add(*mask.add(column + 2) as usize),
                *table.add(*mask.add(column + 3) as usize),
            );
            if !i32x4_all_true(i32x4_eq(entries, skip)) {
                let target = destination.add(column) as *mut v128;
                let result = transition_vector(
                    v128_load(source.add(column) as *const v128),
                    v128_load(target),
                    entries,
                );
                v128_store(target, result);
            }
            column += 4;
        }
        while column < width {
            let entry = *table.add(*mask.add(column) as usize);
            if entry != SKIP {
                let target = destination.add(column);
                *target = if entry == COPY {
                    *source.add(column)
                } else {
                    transition_pixel(*source.add(column), *target, entry)
                };
            }
            column += 1;
        }
    }
}
