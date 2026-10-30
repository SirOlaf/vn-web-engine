//! Float split-radix inverse MDCT. LGPL-2.1-or-later; see src/formats/wma/NOTICE.
//! Trigonometric tables and gather maps are initialized by the shared front end.
use core::slice;

/// Plan: length, gather-map pointer, pre/post rotation pointers, then eight
/// cosine-table pointers for FFT sizes8,16,...1024. Buffers are non-aliasing.
#[no_mangle]
pub unsafe extern "C" fn wma_imdct(
    plan: *const u32,
    input: *const f32,
    output: *mut f32,
    full: u32,
) {
    let plan = slice::from_raw_parts(plan, 12);
    let length = plan[0] as usize;
    let half = length / 2;
    let quarter = length / 4;
    let map = slice::from_raw_parts(plan[1] as *const u32, half);
    let pre = slice::from_raw_parts(plan[2] as *const f32, length);
    let post = slice::from_raw_parts(plan[3] as *const f32, length);
    let input = slice::from_raw_parts(input, length);
    let z = if full != 0 { output.add(half) } else { output };
    for i in 0..half {
        let k = map[i] as usize;
        let re = input[length - 1 - k];
        let im = input[k];
        let wr = pre[2 * i];
        let wi = pre[2 * i + 1];
        *z.add(2 * i) = re * wr - im * wi;
        *z.add(2 * i + 1) = re * wi + im * wr;
    }
    fft(z, half, &plan[4..]);
    for i in 0..quarter {
        let i0 = (quarter + i) * 2;
        let i1 = (quarter - i - 1) * 2;
        let re1 = *z.add(i1 + 1);
        let im1 = *z.add(i1);
        let re0 = *z.add(i0 + 1);
        let im0 = *z.add(i0);
        *z.add(i1) = re1 * post[i1 + 1] - im1 * post[i1];
        *z.add(i0 + 1) = re1 * post[i1] + im1 * post[i1 + 1];
        *z.add(i0) = re0 * post[i0 + 1] - im0 * post[i0];
        *z.add(i1 + 1) = re0 * post[i0] + im0 * post[i0 + 1];
    }
    if full != 0 {
        for i in 0..half {
            *output.add(i) = -*output.add(length - i - 1);
            *output.add(2 * length - i - 1) = *output.add(length + i);
        }
    }
}

#[inline(always)]
unsafe fn fft4(z: *mut f32) {
    let t3 = *z - *z.add(2);
    let t1 = *z + *z.add(2);
    let t8 = *z.add(6) - *z.add(4);
    let t6 = *z.add(6) + *z.add(4);
    *z.add(4) = t1 - t6;
    *z = t1 + t6;
    let t4 = *z.add(1) - *z.add(3);
    let t2 = *z.add(1) + *z.add(3);
    let t7 = *z.add(5) - *z.add(7);
    let t5 = *z.add(5) + *z.add(7);
    *z.add(7) = t4 - t8;
    *z.add(3) = t4 + t8;
    *z.add(6) = t3 - t7;
    *z.add(2) = t3 + t7;
    *z.add(5) = t2 - t5;
    *z.add(1) = t2 + t5;
}

#[inline(always)]
unsafe fn butterflies(
    a0: *mut f32,
    a1: *mut f32,
    a2: *mut f32,
    a3: *mut f32,
    t1: f32,
    t2: f32,
    t5: f32,
    t6: f32,
) {
    let r0 = *a0;
    let i0 = *a0.add(1);
    let r1 = *a1;
    let i1 = *a1.add(1);
    let t3 = t5 - t1;
    let t5 = t5 + t1;
    *a2 = r0 - t5;
    *a0 = r0 + t5;
    *a3.add(1) = i1 - t3;
    *a1.add(1) = i1 + t3;
    let t4 = t2 - t6;
    let t6 = t2 + t6;
    *a3 = r1 - t4;
    *a1 = r1 + t4;
    *a2.add(1) = i0 - t6;
    *a0.add(1) = i0 + t6;
}

#[inline(always)]
unsafe fn transform(a0: *mut f32, a1: *mut f32, a2: *mut f32, a3: *mut f32, wr: f32, wi: f32) {
    let ar = *a2;
    let ai = *a2.add(1);
    let br = *a3;
    let bi = *a3.add(1);
    let t1 = ar * wr - ai * (-wi);
    let t2 = ar * (-wi) + ai * wr;
    let t5 = br * wr - bi * wi;
    let t6 = br * wi + bi * wr;
    butterflies(a0, a1, a2, a3, t1, t2, t5, t6);
}

#[inline(always)]
unsafe fn fft8(z: *mut f32, cosine: &[u32]) {
    fft4(z);
    let t1 = *z.add(8) - (-*z.add(10));
    let t2 = *z.add(9) - (-*z.add(11));
    *z.add(10) = *z.add(8) + (-*z.add(10));
    *z.add(11) = *z.add(9) + (-*z.add(11));
    let t5 = *z.add(12) - (-*z.add(14));
    let t6 = *z.add(13) - (-*z.add(15));
    *z.add(14) = *z.add(12) + (-*z.add(14));
    *z.add(15) = *z.add(13) + (-*z.add(15));
    butterflies(z, z.add(4), z.add(8), z.add(12), t1, t2, t5, t6);
    let c = *((cosine[0] as *const f32).add(1));
    transform(z.add(2), z.add(6), z.add(10), z.add(14), c, c);
}

#[inline(always)]
unsafe fn fft16(z: *mut f32, cosine: &[u32]) {
    fft8(z, cosine);
    fft4(z.add(16));
    fft4(z.add(24));
    let table = slice::from_raw_parts(cosine[1] as *const f32, 5);
    butterflies(
        z,
        z.add(8),
        z.add(16),
        z.add(24),
        *z.add(16),
        *z.add(17),
        *z.add(24),
        *z.add(25),
    );
    transform(
        z.add(4),
        z.add(12),
        z.add(20),
        z.add(28),
        table[2],
        table[2],
    );
    transform(
        z.add(2),
        z.add(10),
        z.add(18),
        z.add(26),
        table[1],
        table[3],
    );
    transform(
        z.add(6),
        z.add(14),
        z.add(22),
        z.add(30),
        table[3],
        table[1],
    );
}

macro_rules! fft_codelet {
    ($name:ident, $half:ident, $quarter:ident, $n:literal, $table:literal) => {
        unsafe fn $name(z: *mut f32, cosine: &[u32]) {
            $half(z, cosine);
            $quarter(z.add($n), cosine);
            $quarter(z.add($n * 3 / 2), cosine);
            let table = slice::from_raw_parts(cosine[$table] as *const f32, $n / 4 + 1);
            for i in 0..$n / 4 {
                transform(
                    z.add(i * 2),
                    z.add((i + $n / 4) * 2),
                    z.add((i + $n / 2) * 2),
                    z.add((i + $n * 3 / 4) * 2),
                    table[i],
                    table[$n / 4 - i],
                );
            }
        }
    };
}
fft_codelet!(fft32, fft16, fft8, 32, 2);
fft_codelet!(fft64, fft32, fft16, 64, 3);
fft_codelet!(fft128, fft64, fft32, 128, 4);
fft_codelet!(fft256, fft128, fft64, 256, 5);
fft_codelet!(fft512, fft256, fft128, 512, 6);
fft_codelet!(fft1024, fft512, fft256, 1024, 7);

unsafe fn fft(z: *mut f32, n: usize, cosine: &[u32]) {
    match n {
        64 => fft64(z, cosine),
        128 => fft128(z, cosine),
        256 => fft256(z, cosine),
        512 => fft512(z, cosine),
        1024 => fft1024(z, cosine),
        _ => core::arch::wasm32::unreachable(),
    }
}
