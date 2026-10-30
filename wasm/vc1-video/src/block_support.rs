//! Internal views into the host-reserved decoder arena and pixel-operation adapters.
//! LGPL-2.1-or-later; see src/formats/vc1/NOTICE and LICENSE.
use super::*;
pub trait Read<T: Copy> {
    unsafe fn at(&self, index: i32) -> T;
}
impl<T: Copy, const N: usize> Read<T> for [T; N] {
    #[inline(always)]
    unsafe fn at(&self, index: i32) -> T {
        *self.get_unchecked(index as usize)
    }
}
impl<T: Copy> Read<T> for [T] {
    #[inline(always)]
    unsafe fn at(&self, index: i32) -> T {
        *self.get_unchecked(index as usize)
    }
}
pub trait Write {
    unsafe fn set(&mut self, index: i32, value: i32);
}
impl<const N: usize> Write for [i32; N] {
    #[inline(always)]
    unsafe fn set(&mut self, index: i32, value: i32) {
        *self.get_unchecked_mut(index as usize) = value;
    }
}
macro_rules! view {
    ($name:ident,$type:ty) => {
        #[derive(Clone, Copy)]
        pub struct $name {
            pub ptr: *mut $type,
            #[allow(dead_code)]
            pub len: i32,
        }
        #[allow(dead_code)] // The shared view API serves all four storage widths.
        impl $name {
            pub fn new(ptr: *mut $type, len: i32) -> Self {
                Self { ptr, len }
            }
            #[inline(always)]
            pub fn length(&self) -> i32 {
                self.len
            }
            #[inline(always)]
            pub unsafe fn at(&self, index: i32) -> i32 {
                *self.ptr.offset(index as isize) as i32
            }
            #[inline(always)]
            pub unsafe fn set(&self, index: i32, value: i32) {
                *self.ptr.offset(index as isize) = value as $type;
            }
            #[inline(always)]
            pub unsafe fn fill_range(&self, value: i32, start: i32, end: i32) {
                if value == 0 {
                    core::ptr::write_bytes(
                        self.ptr.offset(start as isize),
                        0,
                        (end - start) as usize,
                    );
                } else {
                    for i in start..end {
                        self.set(i, value);
                    }
                }
            }
            #[inline(always)]
            pub unsafe fn copy_within(&self, dst: i32, start: i32, end: i32) {
                core::ptr::copy(
                    self.ptr.offset(start as isize),
                    self.ptr.offset(dst as isize),
                    (end - start) as usize,
                );
            }
            #[inline(always)]
            pub unsafe fn copy_from(&self, src: Self, start: i32, end: i32, dst: i32) {
                core::ptr::copy(
                    src.ptr.offset(start as isize),
                    self.ptr.offset(dst as isize),
                    (end - start) as usize,
                );
            }
        }
    };
}
view!(B8, u8);
view!(BS8, i8);
view!(B16, i16);
view!(B32, i32);
#[derive(Clone, Copy)]
pub struct Frame {
    pub y: B8,
    pub cb: B8,
    pub cr: B8,
}
impl Frame {
    pub unsafe fn new(p: *const i32) -> Self {
        Self {
            y: B8::new(*p as *mut u8, 0),
            cb: B8::new(*p.add(1) as *mut u8, 0),
            cr: B8::new(*p.add(2) as *mut u8, 0),
        }
    }
}
pub trait Truth {
    fn truth(self) -> bool;
}
impl Truth for bool {
    #[inline(always)]
    fn truth(self) -> bool {
        self
    }
}
impl Truth for i32 {
    #[inline(always)]
    fn truth(self) -> bool {
        self != 0
    }
}
impl Truth for Frame {
    #[inline(always)]
    fn truth(self) -> bool {
        !self.y.ptr.is_null()
    }
}
#[inline(always)]
pub fn truth<T: Truth>(value: T) -> bool {
    value.truth()
}
#[inline(always)]
pub fn clip(x: i32, lo: i32, hi: i32) -> i32 {
    x.clamp(lo, hi)
}
#[inline(always)]
pub fn mid_pred(a: i32, mut b: i32, c: i32) -> i32 {
    if a > b {
        if c > b {
            b = if c > a { a } else { c };
        }
    } else if b > c {
        b = if c > a { c } else { a };
    }
    b
}
#[inline(always)]
pub fn median4(a: i32, b: i32, c: i32, d: i32) -> i32 {
    if a < b {
        if c < d {
            (a.max(c) + b.min(d)) / 2
        } else {
            (a.max(d) + b.min(c)) / 2
        }
    } else if c < d {
        (b.max(c) + a.min(d)) / 2
    } else {
        (b.max(d) + a.min(c)) / 2
    }
}
pub const DC_PRED: [i32; 32] = [
    65535, 1024, 512, 341, 256, 205, 171, 146, 128, 114, 102, 93, 85, 79, 73, 68, 64, 60, 57, 54,
    51, 49, 47, 45, 43, 41, 39, 38, 37, 35, 34, 33,
];
pub const MV_OFFSET: [i32; 9] = [0, 1, 3, 7, 15, 31, 63, 127, 255];
pub const MV_SIZE: [i32; 6] = [0, 2, 3, 4, 5, 8];
pub const TTBLK_TO_TT: [i32; 24] = [
    3, 6, 0, 7, 2, 1, 4, 5, 0, 4, 5, 7, 3, 6, 1, 2, 0, 6, 7, 1, 4, 5, 3, 2,
];
pub const POPCOUNT4: [i32; 16] = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
pub const CHROMA_INDEX2: [i32; 16] = [0, 0, 0, 1, 0, 2, 0x12, 0, 0, 3, 0x13, 0, 0x23, 0, 0, 0];
#[inline(always)]
pub unsafe fn inv_trans8x8(block: B16, b: i32) {
    vc1_tx8(block.ptr.offset(b as isize));
}
#[inline(always)]
pub unsafe fn inv_trans8x4(dst: B8, o: i32, stride: i32, block: B16, b: i32) {
    vc1_tx_small(
        dst.ptr.offset(o as isize),
        stride as usize,
        block.ptr.offset(b as isize),
        8,
        4,
    );
}
#[inline(always)]
pub unsafe fn inv_trans4x8(dst: B8, o: i32, stride: i32, block: B16, b: i32) {
    vc1_tx_small(
        dst.ptr.offset(o as isize),
        stride as usize,
        block.ptr.offset(b as isize),
        4,
        8,
    );
}
#[inline(always)]
pub unsafe fn inv_trans4x4(dst: B8, o: i32, stride: i32, block: B16, b: i32) {
    vc1_tx_small(
        dst.ptr.offset(o as isize),
        stride as usize,
        block.ptr.offset(b as isize),
        4,
        4,
    );
}
#[inline(always)]
pub unsafe fn inv_trans8x8_dc(dst: B8, o: i32, stride: i32, dc: i32) {
    vc1_tx_dc(dst.ptr.offset(o as isize), stride as usize, 8, 8, dc);
}
#[inline(always)]
pub unsafe fn inv_trans8x4_dc(dst: B8, o: i32, stride: i32, dc: i32) {
    vc1_tx_dc(dst.ptr.offset(o as isize), stride as usize, 8, 4, dc);
}
#[inline(always)]
pub unsafe fn inv_trans4x8_dc(dst: B8, o: i32, stride: i32, dc: i32) {
    vc1_tx_dc(dst.ptr.offset(o as isize), stride as usize, 4, 8, dc);
}
#[inline(always)]
pub unsafe fn inv_trans4x4_dc(dst: B8, o: i32, stride: i32, dc: i32) {
    vc1_tx_dc(dst.ptr.offset(o as isize), stride as usize, 4, 4, dc);
}
#[inline(always)]
pub unsafe fn add_pixels_clamped(block: B16, b: i32, dst: B8, o: i32, stride: i32) {
    vc1_pixels(
        block.ptr.offset(b as isize),
        dst.ptr.offset(o as isize),
        stride as usize,
        2,
    );
}
#[inline(always)]
pub unsafe fn put_mode(block: B16, b: i32, dst: B8, o: i32, stride: i32, signed: bool) {
    vc1_pixels(
        block.ptr.offset(b as isize),
        dst.ptr.offset(o as isize),
        stride as usize,
        if signed { 1 } else { 0 },
    );
}
#[inline(always)]
pub unsafe fn v_loop_filter(dst: B8, o: i32, stride: i32, len: i32, pq: i32) {
    vc1_loop(
        dst.ptr.offset(o as isize),
        1,
        stride as isize,
        len as usize,
        pq,
    );
}
#[inline(always)]
pub unsafe fn h_loop_filter(dst: B8, o: i32, stride: i32, len: i32, pq: i32) {
    vc1_loop(
        dst.ptr.offset(o as isize),
        stride as isize,
        1,
        len as usize,
        pq,
    );
}
#[inline(always)]
pub unsafe fn mspel_mc(
    dst: B8,
    d: i32,
    src: B8,
    s: i32,
    stride: i32,
    n: i32,
    h: i32,
    v: i32,
    rnd: i32,
    avg: bool,
) {
    vc1_mspel(
        dst.ptr.offset(d as isize),
        src.ptr.offset(s as isize),
        stride as usize,
        n as usize,
        h,
        v,
        rnd,
        avg,
    );
}
#[inline(always)]
pub unsafe fn hpel_mc(
    dst: B8,
    d: i32,
    src: B8,
    s: i32,
    stride: i32,
    n: i32,
    dxy: i32,
    no_rnd: bool,
    avg: bool,
) {
    vc1_hpel(
        dst.ptr.offset(d as isize),
        src.ptr.offset(s as isize),
        stride as usize,
        n as usize,
        dxy,
        no_rnd,
        avg,
    );
}
#[inline(always)]
pub unsafe fn chroma_mc(
    dst: B8,
    d: i32,
    src: B8,
    s: i32,
    stride: i32,
    w: i32,
    h: i32,
    x: i32,
    y: i32,
    no_rnd: bool,
    avg: bool,
) {
    vc1_chroma(
        dst.ptr.offset(d as isize),
        src.ptr.offset(s as isize),
        stride as usize,
        w as usize,
        h as usize,
        x,
        y,
        no_rnd,
        avg,
    );
}

pub const PICTURE_I: i32 = 1;
pub const HIGH_MOT_INTRA: i32 = 0;
pub const HIGH_MOT_INTER: i32 = 1;
pub const LOW_MOT_INTRA: i32 = 2;
pub const LOW_MOT_INTER: i32 = 3;
pub const MID_RATE_INTRA: i32 = 4;
pub const MID_RATE_INTER: i32 = 5;
pub const HIGH_RATE_INTRA: i32 = 6;
pub const HIGH_RATE_INTER: i32 = 7;
pub const TT_8X8: i32 = 0;
pub const TT_8X4_BOTTOM: i32 = 1;
pub const TT_8X4_TOP: i32 = 2;
pub const TT_8X4: i32 = 3;
pub const TT_4X8_RIGHT: i32 = 4;
pub const TT_4X8_LEFT: i32 = 5;
pub const TT_4X8: i32 = 6;
pub const TT_4X4: i32 = 7;
pub const LEFT_EDGE: i32 = 1;
pub const RIGHT_EDGE: i32 = 2;
pub const TOP_EDGE: i32 = 4;
pub const BOTTOM_EDGE: i32 = 8;
pub const INVALID_DATA: i32 = -1094995529;
