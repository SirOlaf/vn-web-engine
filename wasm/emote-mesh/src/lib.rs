#![no_std]
//! Per-vertex loops of the emotedriver.dll mesh pass (0x1003f9c0, SHA-256 a3b693b6…5e70b3a86).
//! Twin of `src/native/emotedriver/runtime/mesh/kernel.ts`; both produce identical bits.
//! SSE paths of the native code compute in single precision (every f32 operation below);
//! x87 paths compute in f64 here and round where the native code stores a float.

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Bernstein weights for `segments + 1` samples (0x100286d0); `out` holds 4 floats per sample.
unsafe fn bernstein_table(segments: u32, out: *mut f32) {
    let n = segments as f32 as f64;
    for i in 0..=segments {
        let t = (i as f64 / n) as f32 as f64;
        let s = (1.0 - t) as f32 as f64;
        let o = out.add(i as usize * 4);
        *o = (s * s * s) as f32;
        *o.add(1) = (s * s * t * 3.0) as f32;
        *o.add(2) = (3.0 * (s * t * t)) as f32;
        *o.add(3) = (t * t * t) as f32;
    }
}

/// SSE accumulation of 0x1002cd90 / 0x1003f680 for one point.
#[inline(always)]
unsafe fn patch_point(cp: *const f32, u: *const f32, v: *const f32, out: *mut f32) {
    let mut x = [0f32; 4];
    let mut y = [0f32; 4];
    for r in 0..4usize {
        let w = *v.add(r);
        let p = cp.add(r * 8);
        for k in 0..4usize {
            let uk = *u.add(k);
            let px = (*p.add(k * 2) * uk) * w;
            let py = (*p.add(k * 2 + 1) * uk) * w;
            if r == 0 {
                x[k] = px;
                y[k] = py;
            } else {
                x[k] = px + x[k];
                y[k] = py + y[k];
            }
        }
    }
    *out = (x[3] + x[2]) + (x[1] + x[0]);
    *out.add(1) = (y[3] + y[2]) + (y[1] + y[0]);
}

#[inline(always)]
fn inline_weights(t: f32, out: &mut [f32; 4]) {
    let s = 1.0 - t;
    out[0] = (s * s) * s;
    out[1] = ((3.0 * s) * s) * t;
    out[2] = ((3.0 * s) * t) * t;
    out[3] = (t * t) * t;
}

/// 0x1002cd90 grid: `cp` 32 floats (world x, y pairs), `scratch` room for
/// 4 * (columns + rows + 2) floats, `out` 2 * (columns + 1) * (rows + 1) floats.
#[no_mangle]
pub unsafe extern "C" fn evaluate_patch(
    cp: *const f32,
    columns: u32,
    rows: u32,
    scratch: *mut f32,
    out: *mut f32,
) {
    let u = scratch;
    let v = scratch.add((columns as usize + 1) * 4);
    bernstein_table(columns, u);
    bernstein_table(rows, v);
    let mut at = out;
    for j in 0..=rows as usize {
        for i in 0..=columns as usize {
            patch_point(cp, u.add(i * 4), v.add(j * 4), at);
            at = at.add(2);
        }
    }
}

/// 0x1003f680: `inverse` 4 floats (row-major 2x2), points deformed in place.
#[no_mangle]
pub unsafe extern "C" fn deform_points(
    cp: *const f32,
    inverse: *const f32,
    translate_x: f32,
    translate_y: f32,
    points: *mut f32,
    count: u32,
) {
    let (i0, i1, i2, i3) = (*inverse, *inverse.add(1), *inverse.add(2), *inverse.add(3));
    let mut u = [0f32; 4];
    let mut v = [0f32; 4];
    for k in 0..count as usize {
        let p = points.add(k * 2);
        let a = (*p + translate_x) as f64;
        let b = (*p.add(1) + translate_y) as f64;
        inline_weights((i0 as f64 * a + i1 as f64 * b) as f32, &mut u);
        inline_weights((i2 as f64 * a + i3 as f64 * b) as f32, &mut v);
        patch_point(cp, u.as_ptr(), v.as_ptr(), p);
    }
}

/// 0x1002d960: corners top-left, top-right, bottom-left, bottom-right.
#[no_mangle]
pub unsafe extern "C" fn subdivide_quad(
    corners: *const f32,
    columns: u32,
    rows: u32,
    out: *mut f32,
) {
    let c = |i: usize| *corners.add(i);
    let inv_c = 1.0 / columns as f32;
    let inv_r = 1.0 / rows as f32;
    let mut at = out;
    for j in 0..=rows {
        let t = j as f32 * inv_r;
        let s = 1.0 - t;
        let lx = c(4) * t + s * c(0);
        let ly = t * c(5) + s * c(1);
        let rx = s * c(2) + c(6) * t;
        let ry = s * c(3) + t * c(7);
        for i in 0..=columns {
            let uu = i as f32 * inv_c;
            let su = 1.0 - uu;
            *at = lx * su + rx * uu;
            *at.add(1) = su * ly + ry * uu;
            at = at.add(2);
        }
    }
}

// X64 image 80d28bd0…1e051: double accumulation of each x/y pair. SIMD lanes
// remain independent, preserving the native row/column accumulation order.
use core::arch::wasm32::{f64x2, f64x2_add, f64x2_extract_lane, f64x2_mul, f64x2_splat};

#[inline(always)]
fn weights_x64(t: f64) -> [f64; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t]
}

#[inline(always)]
unsafe fn point_x64(cp: *const f32, u: &[f64; 4], v: &[f64; 4], out: *mut f32) {
    let mut xy = f64x2_splat(0.0);
    for r in 0..4usize {
        for c in 0..4usize {
            let p = cp.add((r * 4 + c) * 2);
            let point = f64x2(*p as f64, *p.add(1) as f64);
            let weight = f64x2_splat(u[c] * v[r]);
            xy = f64x2_add(xy, f64x2_mul(point, weight));
        }
    }
    *out = f64x2_extract_lane::<0>(xy) as f32;
    *out.add(1) = f64x2_extract_lane::<1>(xy) as f32;
}

unsafe fn bernstein_table_x64(segments: u32, out: *mut f32) {
    for i in 0..=segments {
        let t = (i as f64 / segments as f64) as f32 as f64;
        let s = (1.0 - t) as f32 as f64;
        let p = out.add(i as usize * 4);
        *p = (s * s * s) as f32;
        *p.add(1) = (3.0 * s * s * t) as f32;
        *p.add(2) = (3.0 * s * t * t) as f32;
        *p.add(3) = (t * t * t) as f32;
    }
}

#[inline(always)]
unsafe fn table_point(p: *const f32) -> [f64; 4] {
    [
        *p as f64,
        *p.add(1) as f64,
        *p.add(2) as f64,
        *p.add(3) as f64,
    ]
}

/// 0x1800586f0: a grid from world-space float32 control points.
#[no_mangle]
pub unsafe extern "C" fn evaluate_patch_x64(
    cp: *const f32,
    columns: u32,
    rows: u32,
    scratch: *mut f32,
    out: *mut f32,
) {
    let u = scratch;
    let v = scratch.add((columns as usize + 1) * 4);
    bernstein_table_x64(columns, u);
    bernstein_table_x64(rows, v);
    let mut at = out;
    for j in 0..=rows as usize {
        let vv = table_point(v.add(j * 4));
        for i in 0..=columns as usize {
            let uu = table_point(u.add(i * 4));
            point_x64(cp, &uu, &vv, at);
            at = at.add(2);
        }
    }
}

/// Preserve the control-point float store before the double grid accumulation.
#[no_mangle]
pub unsafe extern "C" fn evaluate_transformed_patch_x64(
    cp: *const f32,
    columns: u32,
    rows: u32,
    matrix: *const f64,
    x: f64,
    y: f64,
    scratch: *mut f32,
    out: *mut f32,
) {
    let mut world = [0f32; 32];
    for i in 0..16usize {
        let px = *cp.add(i * 2) as f64;
        let py = *cp.add(i * 2 + 1) as f64;
        world[i * 2] = (*matrix * px + *matrix.add(1) * py + x) as f32;
        world[i * 2 + 1] = (*matrix.add(2) * px + *matrix.add(3) * py + y) as f32;
    }
    evaluate_patch_x64(world.as_ptr(), columns, rows, scratch, out);
}

/// 0x180058320: points already in unit patch coordinates, in place.
#[no_mangle]
pub unsafe extern "C" fn map_patch_points_x64(cp: *const f32, points: *mut f32, count: u32) {
    for i in 0..count as usize {
        let p = points.add(i * 2);
        let u = weights_x64(*p as f64);
        let v = weights_x64(*p.add(1) as f64);
        point_x64(cp, &u, &v, p);
    }
}

/// 0x180058130: double offset/products and one float store per coordinate.
#[no_mangle]
pub unsafe extern "C" fn affine_points_x64(
    matrix: *const f64,
    x: f64,
    y: f64,
    points: *mut f32,
    count: u32,
) {
    for i in 0..count as usize {
        let p = points.add(i * 2);
        let px = *p as f64 + x;
        let py = *p.add(1) as f64 + y;
        *p = (*matrix * px + *matrix.add(1) * py) as f32;
        *p.add(1) = (*matrix.add(2) * px + *matrix.add(3) * py) as f32;
    }
}

/// The x64 ancestor walk: affine float store, then double patch evaluation.
#[no_mangle]
pub unsafe extern "C" fn deform_points_x64(
    cp: *const f32,
    inverse: *const f32,
    x: f64,
    y: f64,
    points: *mut f32,
    count: u32,
) {
    for i in 0..count as usize {
        let p = points.add(i * 2);
        let px = *p as f64 + x;
        let py = *p.add(1) as f64 + y;
        let a = (*inverse as f64 * px + *inverse.add(1) as f64 * py) as f32;
        let b = (*inverse.add(2) as f64 * px + *inverse.add(3) as f64 * py) as f32;
        point_x64(cp, &weights_x64(a as f64), &weights_x64(b as f64), p);
    }
}

/// The x64 quad loop retains double bilinear products until the output store.
#[no_mangle]
pub unsafe extern "C" fn subdivide_quad_x64(
    corners: *const f32,
    columns: u32,
    rows: u32,
    out: *mut f32,
) {
    let c = |i: usize| *corners.add(i) as f64;
    let dv = (1.0 / rows as f64) as f32 as f64;
    let du = (1.0 / columns as f64) as f32 as f64;
    let mut at = out;
    for j in 0..=rows {
        let v = (j as f64 * dv) as f32 as f64;
        let iv = (1.0 - v) as f32 as f64;
        for i in 0..=columns {
            let u = (i as f64 * du) as f32 as f64;
            let iu = (1.0 - u) as f32 as f64;
            *at = (iu * (v * c(4) + c(0) * iv) + u * (c(2) * iv + c(6) * v)) as f32;
            *at.add(1) = ((c(1) * iv + v * c(5)) * iu + (c(3) * iv + v * c(7)) * u) as f32;
            at = at.add(2);
        }
    }
}
