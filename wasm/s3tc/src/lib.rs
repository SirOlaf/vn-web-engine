#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Color index 2 and 3 always interpolate (D3D9 hardware and `EXT_texture_compression_s3tc`
/// decoding of DXT2-5).
pub const MODE_FOUR_COLOR: u32 = 0;
/// emotedriver's software converter: a block with `color0 <= color1` uses the DXT1 three-color
/// layout, where index 2 is the midpoint and index 3 repeats the midpoint's color.
pub const MODE_EMOTEDRIVER: u32 = 1;

/// RGB565 to 8-bit channels by bit replication.
#[inline(always)]
fn expand(color: u32) -> [u32; 3] {
    let r = (color >> 11) & 31;
    let g = (color >> 5) & 63;
    let b = color & 31;
    [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

/// Per channel `(c0 * weight + c1 * (divisor - weight)) / divisor`, truncated.
#[inline(always)]
fn mix(c0: [u32; 3], c1: [u32; 3], weight: u32, divisor: u32) -> [u32; 3] {
    let other = divisor - weight;
    [
        (c0[0] * weight + c1[0] * other) / divisor,
        (c0[1] * weight + c1[1] * other) / divisor,
        (c0[2] * weight + c1[2] * other) / divisor,
    ]
}

#[inline(always)]
unsafe fn block(source: *const u8, mode: u32, out: &mut [[u8; 4]; 16]) {
    let a0 = *source as u32;
    let a1 = *source.add(1) as u32;
    let mut alpha = [0u32; 8];
    alpha[0] = a0;
    alpha[1] = a1;
    if a0 > a1 {
        for i in 1..7u32 {
            alpha[i as usize + 1] = (a0 * (7 - i) + a1 * i) / 7;
        }
    } else {
        for i in 1..5u32 {
            alpha[i as usize + 1] = (a0 * (5 - i) + a1 * i) / 5;
        }
        alpha[6] = 0;
        alpha[7] = 255;
    }
    let mut bits: u64 = 0;
    for i in 0..6 {
        bits |= (*source.add(2 + i) as u64) << (8 * i);
    }

    let raw0 = *source.add(8) as u32 | (*source.add(9) as u32) << 8;
    let raw1 = *source.add(10) as u32 | (*source.add(11) as u32) << 8;
    let c0 = expand(raw0);
    let c1 = expand(raw1);
    let (c2, c3) = if mode == MODE_EMOTEDRIVER && raw0 <= raw1 {
        let mid = mix(c0, c1, 1, 2);
        (mid, mid)
    } else {
        (mix(c0, c1, 2, 3), mix(c0, c1, 1, 3))
    };
    let colors = [c0, c1, c2, c3];
    let indices = *source.add(12) as u32
        | (*source.add(13) as u32) << 8
        | (*source.add(14) as u32) << 16
        | (*source.add(15) as u32) << 24;
    for texel in 0..16 {
        let color = colors[((indices >> (2 * texel)) & 3) as usize];
        let a = alpha[((bits >> (3 * texel)) & 7) as usize];
        out[texel] = [color[0] as u8, color[1] as u8, color[2] as u8, a as u8];
    }
}

/// Decodes a DXT5 (BC3) surface of `width` x `height` texels into tightly packed RGBA8.
/// Blocks are row-major, `ceil(width / 4) * ceil(height / 4)` of 16 bytes; texels of edge
/// blocks outside the surface are skipped. The host validates all spans before entry.
#[no_mangle]
pub unsafe extern "C" fn dxt5_decode(
    source: *const u8,
    width: u32,
    height: u32,
    destination: *mut u8,
    mode: u32,
) {
    let blocks_x = (width + 3) / 4;
    let blocks_y = (height + 3) / 4;
    let pitch = width as usize * 4;
    let mut texels = [[0u8; 4]; 16];
    let mut input = source;
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            block(input, mode, &mut texels);
            input = input.add(16);
            let x0 = bx * 4;
            let y0 = by * 4;
            let columns = if width - x0 < 4 { width - x0 } else { 4 } as usize;
            let rows = if height - y0 < 4 { height - y0 } else { 4 };
            for row in 0..rows {
                let line = destination.add((y0 + row) as usize * pitch + x0 as usize * 4);
                core::ptr::copy_nonoverlapping(
                    texels.as_ptr().add(row as usize * 4) as *const u8,
                    line,
                    columns * 4,
                );
            }
        }
    }
}
