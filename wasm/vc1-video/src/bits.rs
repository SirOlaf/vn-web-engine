//! Checked MSB-first VC-1 bit reading, matching FFmpeg's GetBitContext and the JS twin.
//! LGPL-2.1-or-later; see src/formats/vc1/NOTICE and LICENSE.
#[derive(Clone, Copy)]
pub struct Vlc {
    pub sym: &'static [i16],
    pub len: &'static [i16],
}
#[derive(Clone, Copy)]
pub struct Bits {
    pub data: *const u8,
    pub index: i32,
    pub size: i32,
}
impl Bits {
    #[inline(always)]
    pub unsafe fn show(&self, n: i32) -> i32 {
        if n == 0 {
            return 0;
        }
        let p = self.data.add((self.index >> 3) as usize);
        let word = ((*p as u32) << 24)
            | ((*p.add(1) as u32) << 16)
            | ((*p.add(2) as u32) << 8)
            | *p.add(3) as u32;
        (word.wrapping_shl((self.index & 7) as u32) >> (32 - n)) as i32
    }
    #[inline(always)]
    pub fn skip(&mut self, n: i32) {
        self.index = (self.index + n).min(self.size + 8);
    }
    #[inline(always)]
    pub unsafe fn bits(&mut self, n: i32) -> i32 {
        let x = self.show(n);
        self.skip(n);
        x
    }
    #[inline(always)]
    pub unsafe fn bit(&mut self) -> i32 {
        let value = ((*self.data.add((self.index >> 3) as usize) as u32) << (self.index & 7)) & 128;
        if self.index < self.size + 8 {
            self.index += 1;
        }
        (value >> 7) as i32
    }
    #[inline(always)]
    pub fn left(&self) -> i32 {
        self.size - self.index
    }
    #[inline(always)]
    pub unsafe fn decode012(&mut self) -> i32 {
        if self.bit() != 0 {
            self.bit() + 1
        } else {
            0
        }
    }
    #[inline(always)]
    pub unsafe fn decode210(&mut self) -> i32 {
        if self.bit() != 0 {
            0
        } else {
            2 - self.bit()
        }
    }
    #[inline(always)]
    pub unsafe fn unary(&mut self, stop: i32, limit: i32) -> i32 {
        let mut n = 0;
        while n < limit && self.bit() != stop {
            n += 1;
        }
        n
    }
    #[inline(always)]
    pub unsafe fn vlc(&mut self, table: Vlc, bits: i32, depth: i32) -> i32 {
        let mut index = self.show(bits) as usize;
        let mut code = *table.sym.get_unchecked(index) as i32;
        let mut n = *table.len.get_unchecked(index) as i32;
        if depth > 1 && n < 0 {
            self.skip(bits);
            let mut nb = -n;
            index = (self.show(nb) + code) as usize;
            code = *table.sym.get_unchecked(index) as i32;
            n = *table.len.get_unchecked(index) as i32;
            if depth > 2 && n < 0 {
                self.skip(nb);
                nb = -n;
                index = (self.show(nb) + code) as usize;
                code = *table.sym.get_unchecked(index) as i32;
                n = *table.len.get_unchecked(index) as i32;
            }
        }
        self.skip(n);
        code
    }
}
