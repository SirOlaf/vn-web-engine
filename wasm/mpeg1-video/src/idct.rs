use core::arch::wasm32::*;

/// `BASIS_BY_FREQUENCY` of `idct.ts`, written by the host so its cosines are the reference's.
/// Entry `u * 8 + x` is the basis of frequency `u` at sample `x`.
pub static mut BASIS: [f64; 64] = [0.0; 64];

/// Coefficients of one block in natural order, the nonzero columns that may hold coefficients,
/// and each column's last row that may hold one.
pub struct Block {
    pub coeff: [f64; 64],
    pub columns: u32,
    pub last: [u8; 8],
}

/// Separable binary64 inverse DCT added to (or, for intra blocks, stored into) eight rows.
///
/// The reference adds each sample's products in increasing frequency order, starting from +0.
/// A sum starting from +0 never becomes -0, so the zero products of coefficients or columns
/// it skips are exact no-ops here: every lane performs the reference's unfused operations on
/// identical operands, and the samples are bit-identical.
pub unsafe fn add(block: &mut Block, dest: *mut u8, stride: usize, intra: bool) {
    let basis = &*core::ptr::addr_of!(BASIS);
    let c = &block.coeff;
    if block.columns <= 1 && block.last[0] == 0 {
        // Every sample of a DC-only block is `(0 + c * B0) * B0`; JS adds the second product
        // to +0 as well, so the general sum equals this single product.
        let value = floor(c[0] * basis[0] * basis[0] + 0.5);
        let value = if value < -256.0 {
            -256
        } else if value > 511.0 {
            511
        } else {
            value as i32
        };
        for y in 0..8 {
            let row = dest.add(y * stride);
            for x in 0..8 {
                let p = row.add(x);
                let n = value + if intra { 0 } else { *p as i32 };
                *p = n.clamp(0, 255) as u8;
            }
        }
        clear(block);
        return;
    }
    // Columns: t[u][y] = sum over v of c[v][u] * basis[v][y], vectorized over y.
    let mut t = [0.0f64; 64];
    let mut columns = block.columns;
    while columns != 0 {
        let u = columns.trailing_zeros() as usize;
        columns &= columns - 1;
        let mut a = [f64x2_splat(0.0); 4];
        for v in 0..=block.last[u] as usize {
            let k = f64x2_splat(c[v * 8 + u]);
            let b = basis.as_ptr().add(v * 8) as *const v128;
            for i in 0..4 {
                a[i] = f64x2_add(a[i], f64x2_mul(k, v128_load(b.add(i))));
            }
        }
        for i in 0..4 {
            v128_store(t.as_mut_ptr().add(u * 8 + i * 2) as *mut v128, a[i]);
        }
    }
    // Rows: s[y][x] = sum over u of t[u][y] * basis[u][x], vectorized over x.
    let offset = f64x2_splat(0.5);
    let low = f64x2_splat(-256.0);
    let high = f64x2_splat(511.0);
    for y in 0..8 {
        let mut s = [f64x2_splat(0.0); 4];
        let mut columns = block.columns;
        while columns != 0 {
            let u = columns.trailing_zeros() as usize;
            columns &= columns - 1;
            let k = f64x2_splat(t[u * 8 + y]);
            let b = basis.as_ptr().add(u * 8) as *const v128;
            for i in 0..4 {
                s[i] = f64x2_add(s[i], f64x2_mul(k, v128_load(b.add(i))));
            }
        }
        // Results outside -256..511 clamp to the same byte after adding any sample.
        let mut n = [i32x4_splat(0); 4];
        for i in 0..4 {
            let r = f64x2_floor(f64x2_add(s[i], offset));
            n[i] = i32x4_trunc_sat_f64x2_zero(f64x2_pmax(low, f64x2_pmin(high, r)));
        }
        let mut samples = i16x8_narrow_i32x4(
            i32x4_shuffle::<0, 1, 4, 5>(n[0], n[1]),
            i32x4_shuffle::<0, 1, 4, 5>(n[2], n[3]),
        );
        let row = dest.add(y * stride);
        if !intra {
            samples = i16x8_add(
                samples,
                u16x8_extend_low_u8x16(v128_load64_zero(row as *const u64)),
            );
        }
        v128_store64_lane::<0>(u8x16_narrow_i16x8(samples, samples), row as *mut u64);
    }
    clear(block);
}

/// Zeroes the coefficients the block may have set.
#[inline(always)]
fn clear(block: &mut Block) {
    let mut columns = block.columns;
    while columns != 0 {
        let u = columns.trailing_zeros() as usize;
        columns &= columns - 1;
        for v in 0..=block.last[u] as usize {
            block.coeff[v * 8 + u] = 0.0;
        }
        block.last[u] = 0;
    }
    block.columns = 0;
}

#[inline(always)]
fn floor(value: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(value)))
}
