use crate::{fail, FAIL_RANGE, FAIL_VLC, R};

/// MSB-first reader over one start-code section. Every read is range-checked against the
/// section like `BitReader`; the cache may load up to nine bytes past the section end, which
/// the host's input slack covers, but those bits are never returned.
pub struct Bits {
    base: *const u8,
    pub len: usize,
    pub pos: usize,
    cache: u64,
    count: u32,
    next: *const u8,
}

impl Bits {
    pub unsafe fn new(base: *const u8, bytes: usize) -> Bits {
        let mut bits = Bits {
            base,
            len: bytes * 8,
            pos: 0,
            cache: 0,
            count: 0,
            next: base,
        };
        bits.reload();
        bits
    }

    #[inline(always)]
    unsafe fn load(&mut self) {
        let word = u32::from_be_bytes(core::ptr::read_unaligned(self.next as *const [u8; 4]));
        self.cache |= (word as u64) << (32 - self.count);
        self.count += 32;
        self.next = self.next.add(4);
    }

    unsafe fn reload(&mut self) {
        self.next = self.base.add(self.pos >> 3);
        self.cache = 0;
        self.count = 0;
        self.load();
        self.load();
        let skip = (self.pos & 7) as u32;
        self.cache <<= skip;
        self.count -= skip;
    }

    /// The next `width` (1..=32) bits without a range check.
    #[inline(always)]
    pub fn show(&self, width: u32) -> u32 {
        (self.cache >> (64 - width)) as u32
    }

    /// Consumes `width` (0..=32) bits without a range check.
    #[inline(always)]
    pub unsafe fn consume(&mut self, width: u32) {
        self.cache <<= width;
        self.count -= width;
        self.pos += width as usize;
        if self.count <= 32 {
            self.load();
        }
    }

    #[inline(always)]
    fn check(&self, width: usize) -> R {
        if self.pos + width > self.len {
            return fail(FAIL_RANGE, self.pos as i32, width as i32, self.len as i32);
        }
        Ok(())
    }

    #[inline(always)]
    pub fn peek(&self, width: u32) -> R<u32> {
        self.check(width as usize)?;
        Ok(if width == 0 { 0 } else { self.show(width) })
    }

    #[inline(always)]
    pub unsafe fn read(&mut self, width: u32) -> R<u32> {
        let value = self.peek(width)?;
        self.consume(width);
        Ok(value)
    }

    pub unsafe fn skip(&mut self, width: usize) -> R {
        self.check(width)?;
        if width <= 32 {
            self.consume(width as u32);
        } else {
            self.pos += width;
            self.reload();
        }
        Ok(())
    }
}

/// A prefix code supplied by the host: `1 << primary` lookup entries, then its binary tree as
/// `(zero child, one child, leaf)` triples rooted at node 0. A lookup entry is a leaf
/// `1 << 30 | length << 16 | value`, the internal node reached after `primary` bits
/// `2 << 30 | node`, or zero where the code is invalid within `primary` bits. A leaf word is
/// `1 << 31 | value`; values are 16-bit signed.
#[derive(Clone, Copy)]
pub struct Vlc {
    pub lookup: *const u32,
    pub primary: u32,
    pub tree: *const u32,
}

impl Vlc {
    pub const EMPTY: Vlc = Vlc {
        lookup: core::ptr::null(),
        primary: 0,
        tree: core::ptr::null(),
    };

    #[inline(always)]
    pub unsafe fn read(&self, bits: &mut Bits) -> R<i32> {
        if bits.pos + self.primary as usize <= bits.len {
            let entry = *self.lookup.add(bits.show(self.primary) as usize);
            match entry >> 30 {
                1 => {
                    bits.consume((entry >> 16) & 63);
                    return Ok(entry as u16 as i16 as i32);
                }
                2 => {
                    bits.consume(self.primary);
                    return self.walk(bits, entry & 0xffff);
                }
                _ => {}
            }
        }
        // Invalid or near the section end: the bitwise walk reports the reference's error.
        self.walk(bits, 0)
    }

    #[cold]
    #[inline(never)]
    unsafe fn walk(&self, bits: &mut Bits, mut node: u32) -> R<i32> {
        loop {
            let bit = bits.read(1)?;
            node = *self.tree.add(node as usize * 3 + bit as usize);
            if node == 0 {
                return fail(FAIL_VLC, bits.pos as i32, 0, 0);
            }
            let leaf = *self.tree.add(node as usize * 3 + 2);
            if leaf != 0 {
                return Ok(leaf as u16 as i16 as i32);
            }
        }
    }
}
