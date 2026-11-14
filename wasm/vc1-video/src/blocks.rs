// Progressive block decoder port of src/formats/vc1/reference.ts.
// Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See src/formats/vc1/NOTICE and LICENSE.
use super::block_support::*;
use super::{bits::Bits, tables as T};

struct Decoder {
    mbw: i32,
    mbh: i32,
    mbs: i32,
    b8: i32,
    ls: i32,
    uvls: i32,
    h_edge: i32,
    v_edge: i32,
    origin: i32,
    advanced: i32,
    coded_width: i32,
    coded_height: i32,
    pq: i32,
    pqindex: i32,
    halfpq: i32,
    pquantizer: i32,
    pict_type: i32,
    skipped: i32,
    loop_filter: i32,
    fastuvmc: i32,
    res_rtm: i32,
    quarter_sample: i32,
    mspel: i32,
    rnd: i32,
    mv_type_is_raw: i32,
    skip_is_raw: i32,
    acpred_is_raw: i32,
    ttmbf: i32,
    ttfrm: i32,
    tt_index: i32,
    mv_table: i32,
    cbptab: i32,
    y_ac: i32,
    c_ac: i32,
    dc_table: i32,
    dquantfrm: i32,
    start_mb_y: i32,
    end_mb_y: i32,
    use_ic: i32,
    range_x: i32,
    range_y: i32,
    k_x: i32,
    k_y: i32,
    dc_val: B16,
    ac_val: B16,
    coded_block: B8,
    mb_type: B8,
    motion: B16,
    qscale: BS8,
    cbp_row: B32,
    ttblk_row: B32,
    is_intra_row: B8,
    luma_mv: B16,
    mv_type_plane: B8,
    skip_plane: B8,
    acpred_plane: B8,
    blocks: B16,
    emu: B8,
    codingset: i32,
    codingset2: i32,
    mb_x: i32,
    mb_y: i32,
    first_slice_line: i32,
    dest0: i32,
    dest1: i32,
    cur_blk: i32,
    left_blk: i32,
    topleft_blk: i32,
    top_blk: i32,
    ac_pred: i32,
    mb_intra: i32,
    a_avail: i32,
    c_avail: i32,
    y_dc_scale: i32,
    c_dc_scale: i32,
    esc3_level: i32,
    esc3_run: i32,
    dmv_x: i32,
    dmv_y: i32,
    mb_has_coeffs: i32,
    ac_last: i32,
    ac_run: i32,
    ac_value: i32,
    tt_out: i32,
    dc_dir: i32,
    gb: Bits,
    bi: [i32; 6],
    wrap: [i32; 6],
    mv: [i32; 8],
    cur: Frame,
    last: Frame,
    lut_y: B8,
    lut_uv: B8,
    zz8x4: &'static [i32],
    zz4x8: &'static [i32],
    zz8x8: [&'static [i32]; 4],
    left_sh: i32,
    top_sh: i32,
}
impl Decoder {
    unsafe fn new(p: *const i32, data: *const u8, index: i32, size: i32) -> Self {
        Self {
            mbw: *p.add(0),
            mbh: *p.add(1),
            mbs: *p.add(2),
            b8: *p.add(3),
            ls: *p.add(4),
            uvls: *p.add(5),
            h_edge: *p.add(6),
            v_edge: *p.add(7),
            origin: *p.add(8),
            advanced: *p.add(9),
            coded_width: *p.add(10),
            coded_height: *p.add(11),
            pq: *p.add(12),
            pqindex: *p.add(13),
            halfpq: *p.add(14),
            pquantizer: *p.add(15),
            pict_type: *p.add(16),
            skipped: *p.add(17),
            loop_filter: *p.add(18),
            fastuvmc: *p.add(19),
            res_rtm: *p.add(20),
            quarter_sample: *p.add(21),
            mspel: *p.add(22),
            rnd: *p.add(23),
            mv_type_is_raw: *p.add(24),
            skip_is_raw: *p.add(25),
            acpred_is_raw: *p.add(26),
            ttmbf: *p.add(27),
            ttfrm: *p.add(28),
            tt_index: *p.add(29),
            mv_table: *p.add(30),
            cbptab: *p.add(31),
            y_ac: *p.add(32),
            c_ac: *p.add(33),
            dc_table: *p.add(34),
            dquantfrm: *p.add(35),
            start_mb_y: *p.add(36),
            end_mb_y: *p.add(37),
            use_ic: *p.add(38),
            range_x: *p.add(39),
            range_y: *p.add(40),
            k_x: *p.add(41),
            k_y: *p.add(42),
            dc_val: B16::new(*p.add(43) as *mut _, 0),
            ac_val: B16::new(*p.add(44) as *mut _, 0),
            coded_block: B8::new(*p.add(45) as *mut _, 0),
            mb_type: B8::new(*p.add(46) as *mut _, 0),
            motion: B16::new(*p.add(47) as *mut _, 0),
            qscale: BS8::new(*p.add(48) as *mut _, 0),
            cbp_row: B32::new(*p.add(49) as *mut _, *p.add(2) * 3),
            ttblk_row: B32::new(*p.add(50) as *mut _, *p.add(2) * 3),
            is_intra_row: B8::new(*p.add(51) as *mut _, *p.add(2) * 3),
            luma_mv: B16::new(*p.add(52) as *mut _, *p.add(2) * 6),
            mv_type_plane: B8::new(*p.add(53) as *mut _, 0),
            skip_plane: B8::new(*p.add(54) as *mut _, 0),
            acpred_plane: B8::new(*p.add(55) as *mut _, 0),
            blocks: B16::new(*p.add(56) as *mut _, (*p.add(0) + 2) * 384),
            emu: B8::new(*p.add(57) as *mut _, 0),
            codingset: 0,
            codingset2: 0,
            mb_x: 0,
            mb_y: 0,
            first_slice_line: 0,
            dest0: 0,
            dest1: 0,
            cur_blk: 0,
            left_blk: 0,
            topleft_blk: 0,
            top_blk: 0,
            ac_pred: 0,
            mb_intra: 0,
            a_avail: 0,
            c_avail: 0,
            y_dc_scale: 0,
            c_dc_scale: 0,
            esc3_level: 0,
            esc3_run: 0,
            dmv_x: 0,
            dmv_y: 0,
            mb_has_coeffs: 0,
            ac_last: 0,
            ac_run: 0,
            ac_value: 0,
            tt_out: 0,
            dc_dir: 0,
            gb: Bits { data, index, size },
            bi: [0; 6],
            wrap: [0; 6],
            mv: [0; 8],
            cur: Frame::new(p.add(58)),
            last: Frame::new(p.add(61)),
            lut_y: B8::new(*p.add(64) as *mut u8, 256),
            lut_uv: B8::new(*p.add(65) as *mut u8, 256),
            zz8x4: if *p.add(9) != 0 {
                &T::ZZ_8X4_ADV
            } else {
                &T::WMV2_SCAN_A
            },
            zz4x8: if *p.add(9) != 0 {
                &T::ZZ_4X8_ADV
            } else {
                &T::WMV2_SCAN_B
            },
            zz8x8: T::SCANS,
            left_sh: 0,
            top_sh: 3,
        }
    }
    unsafe fn decode_blocks(&mut self) {
        self.esc3_level = 0;
        self.cur_blk = 0;
        self.left_blk = -1;
        self.topleft_blk = 1;
        self.top_blk = 2;
        if self.pict_type == PICTURE_I {
            if truth(self.advanced) {
                self.i_blocks_adv();
            } else {
                self.i_blocks();
            }
        } else {
            if truth(self.skipped) {
                self.skip_blocks();
            } else {
                self.p_blocks();
            }
        }
    }
    #[inline(always)]
    unsafe fn inc_blocks(&mut self) {
        let n = self.mbw + 2;
        if ({
            self.topleft_blk = self.topleft_blk + 1;
            self.topleft_blk
        } >= n)
        {
            self.topleft_blk = 0;
        }
        if ({
            self.top_blk = self.top_blk + 1;
            self.top_blk
        } >= n)
        {
            self.top_blk = 0;
        }
        if ({
            self.left_blk = self.left_blk + 1;
            self.left_blk
        } >= n)
        {
            self.left_blk = 0;
        }
        if ({
            self.cur_blk = self.cur_blk + 1;
            self.cur_blk
        } >= n)
        {
            self.cur_blk = 0;
        }
    }
    #[inline(always)]
    unsafe fn update_block_index(&mut self) {
        let x = self.mb_x;
        let y = self.mb_y;
        let b8 = self.b8;
        let mbs = self.mbs;

        let base = (b8 * self.mbh) * 2;
        self.bi.set(0, ((b8 * 2) * y) + (2 * x));
        self.bi.set(1, self.bi.at(0) + 1);
        self.bi.set(2, self.bi.at(0) + b8);
        self.bi.set(3, self.bi.at(2) + 1);
        self.bi.set(4, ((mbs * (y + 1)) + base) + x);
        self.bi.set(5, ((mbs * ((y + self.mbh) + 2)) + base) + x);

        {
            let value = {
                let value = {
                    let value = {
                        let value = b8;
                        self.wrap.set(3, value);
                        value
                    };
                    self.wrap.set(2, value);
                    value
                };
                self.wrap.set(1, value);
                value
            };
            self.wrap.set(0, value);
            value
        };
        {
            let value = {
                let value = mbs;
                self.wrap.set(5, value);
                value
            };
            self.wrap.set(4, value);
            value
        };
        self.dest0 = (16 * x) + ((16 * y) * self.ls);
        self.dest1 = (8 * x) + ((8 * y) * self.uvls);
    }
    #[inline(always)]
    unsafe fn blk(&self, ring: i32, n: i32) -> i32 {
        return ((ring * 6) + n) * 64;
    }
    #[inline(always)]
    unsafe fn plane(&self, pic: Frame, n: i32) -> B8 {
        return if n < 4 {
            pic.y
        } else {
            if n == 4 {
                pic.cb
            } else {
                pic.cr
            }
        };
    }
    #[inline(always)]
    unsafe fn set_intra_coding_sets(&mut self) {
        match self.y_ac {
            0 => {
                self.codingset = if self.pqindex <= 8 {
                    HIGH_RATE_INTRA
                } else {
                    LOW_MOT_INTRA
                };
            }
            1 => {
                self.codingset = HIGH_MOT_INTRA;
            }
            2 => {
                self.codingset = MID_RATE_INTRA;
            }
            _ => {}
        }
        self.set_inter_coding_set();
    }
    #[inline(always)]
    unsafe fn set_inter_coding_set(&mut self) {
        match self.c_ac {
            0 => {
                self.codingset2 = if self.pqindex <= 8 {
                    HIGH_RATE_INTER
                } else {
                    LOW_MOT_INTER
                };
            }
            1 => {
                self.codingset2 = HIGH_MOT_INTER;
            }
            2 => {
                self.codingset2 = MID_RATE_INTER;
            }
            _ => {}
        }
    }
    #[inline(always)]
    unsafe fn coded_block_pred(&mut self, n: i32) -> i32 {
        let xy = self.origin + self.bi.at(n);
        let wrap = self.b8;
        let cb = self.coded_block;
        let a = cb.at(xy - 1);
        let b = cb.at((xy - 1) - wrap);
        let c = cb.at(xy - wrap);
        return if b == c { a } else { c };
    }
    unsafe fn i_blocks(&mut self) {
        let blocks = self.blocks;
        self.set_intra_coding_sets();
        {
            let value = {
                let value = T::DC_SCALE.at(self.pq);
                self.c_dc_scale = value;
                value
            };
            self.y_dc_scale = value;
            value
        };
        self.mb_intra = 1;
        self.first_slice_line = 1;
        for position in self.start_mb_y..self.end_mb_y {
            self.mb_y = position;
            for position in 0..self.mbw {
                self.mb_x = position;
                self.update_block_index();
                let base = self.blk(self.cur_blk, 0);
                blocks.fill_range(0, base, base + 384);
                let mut cbp = self.gb.vlc(T::MB_I.at(0), 9, 2);
                self.ac_pred = self.gb.bit();
                for k in 0..6 {
                    self.mb_type.set(self.origin + self.bi.at(k), 1);
                    let mut val = (cbp >> (5 - k)) & 1;
                    if k < 4 {
                        val = val ^ self.coded_block_pred(k);
                        self.coded_block.set(self.origin + self.bi.at(k), val);
                    }
                    cbp = cbp | (val << (5 - k));
                    self.i_block(
                        base + (k * 64),
                        k,
                        val,
                        if k < 4 {
                            self.codingset
                        } else {
                            self.codingset2
                        },
                    );
                    inv_trans8x8(blocks, base + (k * 64));
                }
                self.put_blocks(false);
                if truth(self.loop_filter) {
                    self.i_loop_filter();
                }
                if self.gb.left() < 0 {
                    return;
                }
                self.inc_blocks();
            }
            self.first_slice_line = 0;
        }
    }
    unsafe fn i_blocks_adv(&mut self) {
        let blocks = self.blocks;
        if self.gb.left() <= 1 {
            return;
        }
        self.set_intra_coding_sets();
        self.mb_intra = 1;
        self.first_slice_line = 1;
        self.mb_x = 0;
        self.mb_y = self.start_mb_y;
        if truth(self.start_mb_y) {
            let o = (self.origin + (((2 * self.mb_y) - 1) * self.b8)) - 2;
            self.coded_block.fill_range(0, o, (o + 1) + self.b8);
        }
        for position in self.mb_y..self.end_mb_y {
            self.mb_y = position;
            for position in 0..self.mbw {
                self.mb_x = position;
                let mquant = self.pq;
                self.update_block_index();
                let base = self.blk(self.cur_blk, 0);
                blocks.fill_range(0, base, base + 384);
                let mb_pos = self.mb_x + (self.mb_y * self.mbs);
                if self.gb.left() <= 1 {
                    return;
                }
                let mut cbp = self.gb.vlc(T::MB_I.at(0), 9, 2);
                self.ac_pred = if truth(self.acpred_is_raw) {
                    self.gb.bit()
                } else {
                    self.acpred_plane.at(mb_pos)
                };
                self.qscale.set(self.mbs + mb_pos, mquant);
                {
                    let value = {
                        let value = T::DC_SCALE.at((mquant).abs());
                        self.c_dc_scale = value;
                        value
                    };
                    self.y_dc_scale = value;
                    value
                };
                for k in 0..6 {
                    self.mb_type.set(self.origin + self.bi.at(k), 1);
                    let mut val = (cbp >> (5 - k)) & 1;
                    if k < 4 {
                        val = val ^ self.coded_block_pred(k);
                        self.coded_block.set(self.origin + self.bi.at(k), val);
                    }
                    cbp = cbp | (val << (5 - k));
                    self.a_avail = if ((!truth(self.first_slice_line)) || (k == 2)) || (k == 3) {
                        1
                    } else {
                        0
                    };
                    self.c_avail = if (truth(self.mb_x) || (k == 1)) || (k == 3) {
                        1
                    } else {
                        0
                    };
                    self.i_block_adv(
                        base + (k * 64),
                        k,
                        val,
                        if k < 4 {
                            self.codingset
                        } else {
                            self.codingset2
                        },
                        mquant,
                    );
                    inv_trans8x8(blocks, base + (k * 64));
                }
                self.put_blocks(true);
                if truth(self.loop_filter) {
                    self.i_loop_filter();
                }
                if self.gb.left() < 0 {
                    return;
                }
                self.inc_blocks();
            }
            self.first_slice_line = 0;
        }
    }
    unsafe fn p_blocks(&mut self) {
        let mbs = self.mbs;
        match self.c_ac {
            0 => {
                self.codingset = if self.pqindex <= 8 {
                    HIGH_RATE_INTRA
                } else {
                    LOW_MOT_INTRA
                };
            }
            1 => {
                self.codingset = HIGH_MOT_INTRA;
            }
            2 => {
                self.codingset = MID_RATE_INTRA;
            }
            _ => {}
        }
        self.set_inter_coding_set();
        self.first_slice_line = 1;
        self.cbp_row.fill_range(0, 0, self.cbp_row.length());
        for position in self.start_mb_y..self.end_mb_y {
            self.mb_y = position;
            for position in 0..self.mbw {
                self.mb_x = position;
                self.update_block_index();
                if (truth(self.mv_type_is_raw) || truth(self.skip_is_raw)) && (self.gb.left() <= 1)
                {
                    return;
                }
                let ret = self.p_mb();
                if truth(self.loop_filter) {
                    self.p_loop_filter();
                }
                if (ret < 0) || (self.gb.left() < 0) {
                    return;
                }
                self.inc_blocks();
            }
            self.cbp_row.copy_within(0, mbs, 3 * mbs);
            self.ttblk_row.copy_within(0, mbs, 3 * mbs);
            self.is_intra_row.copy_within(0, mbs, 3 * mbs);
            self.luma_mv.copy_within(0, 2 * mbs, 6 * mbs);
            self.first_slice_line = 0;
        }
    }
    #[inline(always)]
    unsafe fn skip_blocks(&mut self) {
        let last = self.last;
        let cur = self.cur;
        if !truth(last) {
            return;
        }
        for y in self.start_mb_y..self.end_mb_y {
            let o = (y * 16) * self.ls;
            let c = (y * 8) * self.uvls;
            cur.y.copy_from(last.y, o, o + (self.ls * 16), o);
            cur.cb.copy_from(last.cb, c, c + (self.uvls * 8), c);
            cur.cr.copy_from(last.cr, c, c + (self.uvls * 8), c);
        }
    }
    #[inline(always)]
    unsafe fn p_mb(&mut self) -> i32 {
        let blocks = self.blocks;
        let cur = self.cur;
        let o = self.origin;

        let mb_pos = self.mb_x + (self.mb_y * self.mbs);
        let mut mquant = self.pq;
        let mut ttmb = self.ttfrm;
        let mut first_block = 1;
        let mut block_cbp = 0;
        let mut block_intra = 0;
        self.tt_out = 0;
        self.mb_has_coeffs = 1;
        let fourmv = if truth(self.mv_type_is_raw) {
            self.gb.bit()
        } else {
            self.mv_type_plane.at(mb_pos)
        };
        let skipped = if truth(self.skip_is_raw) {
            self.gb.bit()
        } else {
            self.skip_plane.at(mb_pos)
        };
        let base = self.blk(self.cur_blk, 0);
        'end: {
            if !truth(fourmv) {
                if !truth(skipped) {
                    self.get_mv_data();
                    self.pred_mv(0, self.dmv_x, self.dmv_y, true);
                    let cbp: i32;
                    if truth(self.mb_intra) && (!truth(self.mb_has_coeffs)) {
                        self.ac_pred = self.gb.bit();
                        cbp = 0;
                    } else {
                        if truth(self.mb_has_coeffs) {
                            if truth(self.mb_intra) {
                                self.ac_pred = self.gb.bit();
                            }
                            cbp = self.gb.vlc(T::CBPCY.at(self.cbptab), 9, 2);
                        } else {
                            mquant = self.pq;
                            cbp = 0;
                        }
                    }
                    self.qscale.set(self.mbs + mb_pos, mquant);
                    if ((!truth(self.ttmbf)) && (!truth(self.mb_intra)))
                        && truth(self.mb_has_coeffs)
                    {
                        ttmb = self.gb.vlc(T::TTMB.at(self.tt_index), 9, 2);
                    }
                    if !truth(self.mb_intra) {
                        self.mc1mv();
                    }
                    for i in 0..6 {
                        self.dc_val.set(o + self.bi.at(i), 0);
                        let val = (cbp >> (5 - i)) & 1;
                        let off = if truth(i & 4) {
                            0
                        } else {
                            ((i & 1) * 8) + (((i & 2) * 4) * self.ls)
                        };
                        self.mb_type.set(o + self.bi.at(i), self.mb_intra);
                        if truth(self.mb_intra) {
                            self.set_intra_avail(i);
                            let ret = self.intra_block(
                                base + (i * 64),
                                i,
                                val,
                                mquant,
                                if truth(i & 4) {
                                    self.codingset2
                                } else {
                                    self.codingset
                                },
                            );
                            if ret < 0 {
                                return ret;
                            }
                            inv_trans8x8(blocks, base + (i * 64));
                            block_cbp = block_cbp | (15 << (i << 2));
                            block_intra = block_intra | (1 << i);
                        } else {
                            if truth(val) {
                                let pat = self.p_block(
                                    base + (i * 64),
                                    i,
                                    mquant,
                                    ttmb,
                                    first_block,
                                    self.plane(cur, i),
                                    (if truth(i & 4) { self.dest1 } else { self.dest0 }) + off,
                                    if truth(i & 4) { self.uvls } else { self.ls },
                                );
                                if pat < 0 {
                                    return pat;
                                }
                                block_cbp = block_cbp | (pat << (i << 2));
                                if (!truth(self.ttmbf)) && (ttmb < 8) {
                                    ttmb = -1;
                                }
                                first_block = 0;
                            }
                        }
                    }
                } else {
                    self.mb_intra = 0;
                    for i in 0..6 {
                        self.mb_type.set(o + self.bi.at(i), 0);
                        self.dc_val.set(o + self.bi.at(i), 0);
                    }
                    self.qscale.set(self.mbs + mb_pos, 0);
                    self.pred_mv(0, 0, 0, true);
                    self.mc1mv();
                }
            } else {
                if !truth(skipped) {
                    let mut intra_count = 0;
                    let mut coded_inter = 0;
                    let mut is_intra = [0, 0, 0, 0, 0, 0];
                    let mut is_coded = [0, 0, 0, 0, 0, 0];
                    let cbp = self.gb.vlc(T::CBPCY.at(self.cbptab), 9, 2);
                    for i in 0..6 {
                        let val = (cbp >> (5 - i)) & 1;
                        self.dc_val.set(o + self.bi.at(i), 0);
                        self.mb_intra = 0;
                        if i < 4 {
                            {
                                let value = {
                                    let value = 0;
                                    self.dmv_y = value;
                                    value
                                };
                                self.dmv_x = value;
                                value
                            };
                            self.mb_intra = 0;
                            self.mb_has_coeffs = 0;
                            if truth(val) {
                                self.get_mv_data();
                            }
                            self.pred_mv(i, self.dmv_x, self.dmv_y, false);
                            if !truth(self.mb_intra) {
                                self.mc4mv_luma(i);
                            }
                            intra_count = intra_count + self.mb_intra;
                            is_intra.set(i, self.mb_intra);
                            is_coded.set(i, self.mb_has_coeffs);
                        }
                        if truth(i & 4) {
                            is_intra.set(i, if intra_count >= 3 { 1 } else { 0 });
                            is_coded.set(i, val);
                        }
                        if i == 4 {
                            self.mc4mv_chroma();
                        }
                        self.mb_type.set(o + self.bi.at(i), is_intra.at(i));
                        if !truth(coded_inter) {
                            coded_inter = if (!truth(is_intra.at(i))) && truth(is_coded.at(i)) {
                                1
                            } else {
                                0
                            };
                        }
                    }
                    if (!truth(intra_count)) && (!truth(coded_inter)) {
                        break 'end;
                    }
                    self.qscale.set(self.mbs + mb_pos, mquant);
                    let mut intrapred = 0;
                    for i in 0..6 {
                        if truth(is_intra.at(i)) {
                            let w = self.wrap.at(i);
                            if ((((!truth(self.first_slice_line)) || (i == 2)) || (i == 3))
                                && truth(self.mb_type.at((o + self.bi.at(i)) - w)))
                                || (((truth(self.mb_x) || (i == 1)) || (i == 3))
                                    && truth(self.mb_type.at((o + self.bi.at(i)) - 1)))
                            {
                                intrapred = 1;
                                break;
                            }
                        }
                    }
                    self.ac_pred = if truth(intrapred) { self.gb.bit() } else { 0 };
                    if (!truth(self.ttmbf)) && truth(coded_inter) {
                        ttmb = self.gb.vlc(T::TTMB.at(self.tt_index), 9, 2);
                    }
                    for i in 0..6 {
                        let off = if truth(i & 4) {
                            0
                        } else {
                            ((i & 1) * 8) + (((i & 2) * 4) * self.ls)
                        };
                        self.mb_intra = is_intra.at(i);
                        if truth(is_intra.at(i)) {
                            self.set_intra_avail(i);
                            let ret = self.intra_block(
                                base + (i * 64),
                                i,
                                is_coded.at(i),
                                mquant,
                                if truth(i & 4) {
                                    self.codingset2
                                } else {
                                    self.codingset
                                },
                            );
                            if ret < 0 {
                                return ret;
                            }
                            inv_trans8x8(blocks, base + (i * 64));
                            block_cbp = block_cbp | (15 << (i << 2));
                            block_intra = block_intra | (1 << i);
                        } else {
                            if truth(is_coded.at(i)) {
                                let pat = self.p_block(
                                    base + (i * 64),
                                    i,
                                    mquant,
                                    ttmb,
                                    first_block,
                                    self.plane(cur, i),
                                    (if truth(i & 4) { self.dest1 } else { self.dest0 }) + off,
                                    if truth(i & 4) { self.uvls } else { self.ls },
                                );
                                if pat < 0 {
                                    return pat;
                                }
                                block_cbp = block_cbp | (pat << (i << 2));
                                if (!truth(self.ttmbf)) && (ttmb < 8) {
                                    ttmb = -1;
                                }
                                first_block = 0;
                            }
                        }
                    }
                } else {
                    self.mb_intra = 0;
                    self.qscale.set(self.mbs + mb_pos, 0);
                    for i in 0..6 {
                        self.mb_type.set(o + self.bi.at(i), 0);
                        self.dc_val.set(o + self.bi.at(i), 0);
                    }
                    for i in 0..4 {
                        self.pred_mv(i, 0, 0, false);
                        self.mc4mv_luma(i);
                    }
                    self.mc4mv_chroma();
                }
            }
        }
        self.put_blocks(true);
        let m = (2 * self.mbs) + self.mb_x;
        self.cbp_row.set(m, block_cbp);
        self.ttblk_row.set(m, self.tt_out);
        self.is_intra_row.set(m, block_intra);
        return 0;
    }
    #[inline(always)]
    unsafe fn set_intra_avail(&mut self, i: i32) {
        let o = self.origin + self.bi.at(i);
        {
            let value = {
                let value = 0;
                self.c_avail = value;
                value
            };
            self.a_avail = value;
            value
        };
        if ((i == 2) || (i == 3)) || (!truth(self.first_slice_line)) {
            self.a_avail = self.mb_type.at(o - self.wrap.at(i));
        }
        if ((i == 1) || (i == 3)) || truth(self.mb_x) {
            self.c_avail = self.mb_type.at(o - 1);
        }
    }
    #[inline(always)]
    unsafe fn get_mv_data(&mut self) {
        let qs = self.quarter_sample;
        let mut index = 1 + self.gb.vlc(T::MV_DIFF.at(self.mv_table), 9, 2);
        if index > 36 {
            self.mb_has_coeffs = 1;
            index = index - 37;
        } else {
            self.mb_has_coeffs = 0;
        }
        self.mb_intra = 0;
        if !truth(index) {
            {
                let value = {
                    let value = 0;
                    self.dmv_y = value;
                    value
                };
                self.dmv_x = value;
                value
            };
        } else {
            if index == 35 {
                self.dmv_x = self.gb.bits((self.k_x - 1) + qs);
                self.dmv_y = self.gb.bits((self.k_y - 1) + qs);
            } else {
                if index == 36 {
                    {
                        let value = {
                            let value = 0;
                            self.dmv_y = value;
                            value
                        };
                        self.dmv_x = value;
                        value
                    };
                    self.mb_intra = 1;
                } else {
                    let mut component = |i: i32| -> i32 {
                        let mut v = MV_OFFSET.at(i);
                        let mut n = MV_SIZE.at(i) - (if (!truth(qs)) && (i == 5) { 1 } else { 0 });
                        if n > 0 {
                            n = self.gb.bits(n);
                            let sign = -(n & 1);
                            v = (sign ^ ((n >> 1) + v)) - sign;
                        }
                        v
                    };
                    self.dmv_x = component(index % 6);
                    self.dmv_y = component((index / 6) | 0);
                }
            }
        }
    }
    #[inline(always)]
    unsafe fn ac_coeff(&mut self, cs: i32) -> i32 {
        let vlc = T::AC.at(cs);
        let size = T::AC_SIZES.at(cs);
        let mut index = self.gb.vlc(vlc, 9, 3);
        if index < 0 {
            return index;
        }
        let mut run: i32;
        let mut level: i32;
        let lst: i32;
        let sign: i32;
        if index != (size - 1) {
            run = T::INDEX_DECODE.at(((cs * 185) + index) * 2);
            level = T::INDEX_DECODE.at((((cs * 185) + index) * 2) + 1);
            lst = if (index >= T::LAST_DECODE.at(cs)) || (self.gb.left() < 0) {
                1
            } else {
                0
            };
            sign = self.gb.bit();
        } else {
            let escape = self.gb.decode210();
            if escape != 2 {
                index = self.gb.vlc(vlc, 9, 3);
                if ((((index) as u32 >> (0)) as i32) as u32) >= ((size - 1) as u32) {
                    return INVALID_DATA;
                }
                run = T::INDEX_DECODE.at(((cs * 185) + index) * 2);
                level = T::INDEX_DECODE.at((((cs * 185) + index) * 2) + 1);
                lst = if index >= T::LAST_DECODE.at(cs) { 1 } else { 0 };
                if escape == 0 {
                    level = level
                        + (if truth(lst) {
                            T::LAST_DELTA_LEVEL.at((cs * 44) + run)
                        } else {
                            T::DELTA_LEVEL.at((cs * 31) + run)
                        });
                } else {
                    run = run
                        + ((if truth(lst) {
                            T::LAST_DELTA_RUN.at((cs * 10) + level)
                        } else {
                            T::DELTA_RUN.at((cs * 57) + level)
                        }) + 1);
                }
                sign = self.gb.bit();
            } else {
                lst = self.gb.bit();
                if self.esc3_level == 0 {
                    if (self.pq < 8) || truth(self.dquantfrm) {
                        self.esc3_level = self.gb.bits(3);
                        if !truth(self.esc3_level) {
                            self.esc3_level = self.gb.bits(2) + 8;
                        }
                    } else {
                        self.esc3_level = self.gb.unary(1, 6) + 2;
                    }
                    self.esc3_run = 3 + self.gb.bits(2);
                }
                run = self.gb.bits(self.esc3_run);
                sign = self.gb.bit();
                level = self.gb.bits(self.esc3_level);
            }
        }
        self.ac_last = lst;
        self.ac_run = run;
        self.ac_value = (level ^ (-sign)) + sign;
        return 0;
    }
    #[inline(always)]
    unsafe fn dc_diff(&mut self, n: i32, quant: i32) -> i32 {
        let mut dcdiff = self.gb.vlc(
            T::DC.at((self.dc_table * 2) + (if n >= 4 { 1 } else { 0 })),
            9,
            3,
        );
        if truth(dcdiff) {
            let m = if (quant == 1) || (quant == 2) {
                3 - quant
            } else {
                0
            };
            if dcdiff == 119 {
                dcdiff = self.gb.bits(8 + m);
            } else {
                if truth(m) {
                    dcdiff = ((dcdiff << m) + self.gb.bits(m)) - ((1 << m) - 1);
                }
            }
            if truth(self.gb.bit()) {
                dcdiff = -dcdiff;
            }
        }
        return dcdiff;
    }
    #[inline(always)]
    unsafe fn pred_dc(&mut self, n: i32, a_avail: i32, c_avail: i32) -> i32 {
        let mbs = self.mbs;
        let q = self.qscale;
        let mb_pos = (mbs + self.mb_x) + (self.mb_y * mbs);
        let q1 = (q.at(mb_pos)).abs();
        let dqi = T::DC_SCALE.at(q1) - 1;
        if dqi < 0 {
            return 0;
        }
        let dq = T::DQSCALE.at(dqi);

        let wrap = self.wrap.at(n);
        let xy = self.origin + self.bi.at(n);
        let dc = self.dc_val;
        let mut c = dc.at(xy - 1);
        let mut b = dc.at((xy - 1) - wrap);
        let mut a = dc.at(xy - wrap);
        if (truth(c_avail) && (n != 1)) && (n != 3) {
            let q2 = (q.at(mb_pos - 1)).abs();
            if truth(q2) && (q2 != q1) {
                c = ((((c).wrapping_mul(T::DC_SCALE.at(q2))).wrapping_mul(dq) + 131072) | 0) >> 18;
            }
        }
        if (truth(a_avail) && (n != 2)) && (n != 3) {
            let q2 = (q.at(mb_pos - mbs)).abs();
            if truth(q2) && (q2 != q1) {
                a = ((((a).wrapping_mul(T::DC_SCALE.at(q2))).wrapping_mul(dq) + 131072) | 0) >> 18;
            }
        }
        if (truth(a_avail) && truth(c_avail)) && (n != 3) {
            let mut off = mb_pos;
            if n != 1 {
                off = off - 1;
            }
            if n != 2 {
                off = off - mbs;
            }
            let q2 = (q.at(off)).abs();
            if truth(q2) && (q2 != q1) {
                b = ((((b).wrapping_mul(T::DC_SCALE.at(q2))).wrapping_mul(dq) + 131072) | 0) >> 18;
            }
        }
        if truth(c_avail) && ((!truth(a_avail)) || ((a - b).abs() <= (b - c).abs())) {
            self.dc_dir = 1;
            return c;
        }
        if truth(a_avail) {
            self.dc_dir = 0;
            return a;
        }
        self.dc_dir = 1;
        return 0;
    }
    #[inline(always)]
    unsafe fn i_block(&mut self, b: i32, n: i32, coded: i32, codingset: i32) -> i32 {
        let block = self.blocks;
        let pq = self.pq;
        let mut dcdiff = self.dc_diff(n, pq);
        let scale = if n < 4 {
            self.y_dc_scale
        } else {
            self.c_dc_scale
        };
        let wrap = self.wrap.at(n);
        let xy = self.origin + self.bi.at(n);
        let dc = self.dc_val;
        let mut c = dc.at(xy - 1);
        let mut bb = dc.at((xy - 1) - wrap);
        let mut a = dc.at(xy - wrap);
        if (truth(self.first_slice_line) && (n != 2)) && (n != 3) {
            {
                let value = {
                    let value = DC_PRED.at(scale);
                    a = value;
                    value
                };
                bb = value;
                value
            };
        }
        if ((self.mb_x == 0) && (n != 1)) && (n != 3) {
            {
                let value = {
                    let value = DC_PRED.at(scale);
                    c = value;
                    value
                };
                bb = value;
                value
            };
        }
        let dir: i32;
        if (a - bb).abs() <= (bb - c).abs() {
            dcdiff = dcdiff + c;
            dir = 1;
        } else {
            dcdiff = dcdiff + a;
            dir = 0;
        }
        dc.set(xy, dcdiff);
        block.set(b, dcdiff * scale);
        let ac = self.ac_val;
        let ac2 = xy * 16;
        let mut acv = if truth(dir) {
            ac2 - 16
        } else {
            ac2 - (16 * wrap)
        };
        let qscale = (pq * 2) + self.halfpq;
        let left_sh = self.left_sh;
        let top_sh = self.top_sh;
        if truth(coded) {
            let zz = if truth(self.ac_pred) {
                if truth(dir) {
                    self.zz8x8.at(3)
                } else {
                    self.zz8x8.at(2)
                }
            } else {
                self.zz8x8.at(1)
            };
            let mut i = 1;
            let mut last = 0;
            while !truth(last) {
                let ret = self.ac_coeff(codingset);
                if ret < 0 {
                    return ret;
                }
                last = self.ac_last;
                i = i + self.ac_run;
                if i > 63 {
                    break;
                }
                block.set(
                    b + zz.at({
                        let previous = i;
                        i = i + 1;
                        previous
                    }),
                    self.ac_value,
                );
            }
            if truth(self.ac_pred) {
                let sh: i32;
                if truth(dir) {
                    sh = left_sh;
                } else {
                    sh = top_sh;
                    acv = acv + 8;
                }
                for k in 1..8 {
                    block.set(b + (k << sh), block.at(b + (k << sh)) + ac.at(acv + k));
                }
            }
            for k in 1..8 {
                ac.set(ac2 + k, block.at(b + (k << left_sh)));
                ac.set((ac2 + k) + 8, block.at(b + (k << top_sh)));
            }
            for k in 1..64 {
                if truth(block.at(b + k)) {
                    block.set(b + k, block.at(b + k) * qscale);
                    if !truth(self.pquantizer) {
                        block.set(
                            b + k,
                            block.at(b + k) + (if block.at(b + k) < 0 { -pq } else { pq }),
                        );
                    }
                }
            }
        } else {
            ac.fill_range(0, ac2, ac2 + 16);
            if truth(self.ac_pred) {
                let sh: i32;
                let mut dst = ac2;
                if truth(dir) {
                    sh = left_sh;
                } else {
                    sh = top_sh;
                    acv = acv + 8;
                    dst = dst + 8;
                }
                ac.copy_within(dst, acv, acv + 8);
                for k in 1..8 {
                    let p = b + (k << sh);
                    block.set(p, ac.at(acv + k) * qscale);
                    if (!truth(self.pquantizer)) && truth(block.at(p)) {
                        block.set(p, block.at(p) + (if block.at(p) < 0 { -pq } else { pq }));
                    }
                }
            }
        }
        return 0;
    }
    #[inline(always)]
    unsafe fn i_block_adv(
        &mut self,
        b: i32,
        n: i32,
        coded: i32,
        codingset: i32,
        mquant: i32,
    ) -> i32 {
        let block = self.blocks;
        let a_avail = self.a_avail;
        let c_avail = self.c_avail;
        let quant = (mquant).abs();
        let mbs = self.mbs;
        let raw_pos = self.mb_x + (self.mb_y * mbs);
        let mb_pos = mbs + raw_pos;
        let mut use_pred = self.ac_pred;
        let mut dcdiff = self.dc_diff(n, quant);
        dcdiff = dcdiff + self.pred_dc(n, a_avail, c_avail);
        let dir = self.dc_dir;
        let xy = self.origin + self.bi.at(n);
        self.dc_val.set(xy, dcdiff);
        block.set(
            b,
            dcdiff
                * (if n < 4 {
                    self.y_dc_scale
                } else {
                    self.c_dc_scale
                }),
        );
        if (!truth(a_avail)) && (!truth(c_avail)) {
            use_pred = 0;
        }
        let scale = (quant * 2) + (if mquant < 0 { 0 } else { self.halfpq });
        let ac = self.ac_val;
        let ac2 = xy * 16;
        let mut acv = if truth(dir) {
            ac2 - 16
        } else {
            ac2 - (16 * self.wrap.at(n))
        };
        let mut q1 = self.qscale.at(mb_pos);
        let mut q2 = 0;
        if n == 3 {
            q2 = q1;
        } else {
            if truth(dir) {
                if n == 1 {
                    q2 = q1;
                } else {
                    if truth(c_avail) && truth(raw_pos) {
                        q2 = self.qscale.at(mb_pos - 1);
                    }
                }
            } else {
                if n == 2 {
                    q2 = q1;
                } else {
                    if truth(a_avail) && (raw_pos >= mbs) {
                        q2 = self.qscale.at(mb_pos - mbs);
                    }
                }
            }
        }
        let left_sh = self.left_sh;
        let top_sh = self.top_sh;
        let halfpq = self.halfpq;

        if truth(coded) {
            let zz = if truth(self.ac_pred) {
                if truth(dir) {
                    self.zz8x8.at(3)
                } else {
                    self.zz8x8.at(2)
                }
            } else {
                self.zz8x8.at(1)
            };
            let mut i = 1;
            let mut last = 0;
            while !truth(last) {
                let ret = self.ac_coeff(codingset);
                if ret < 0 {
                    return ret;
                }
                last = self.ac_last;
                i = i + self.ac_run;
                if i > 63 {
                    break;
                }
                block.set(
                    b + zz.at({
                        let previous = i;
                        i = i + 1;
                        previous
                    }),
                    self.ac_value,
                );
            }
            if truth(use_pred) {
                let sh: i32;
                if truth(dir) {
                    sh = left_sh;
                } else {
                    sh = top_sh;
                    acv = acv + 8;
                }
                q1 = (((q1).abs() * 2) + (if q1 < 0 { 0 } else { halfpq })) - 1;
                if q1 < 1 {
                    return INVALID_DATA;
                }
                if truth(q2) {
                    q2 = (((q2).abs() * 2) + (if q2 < 0 { 0 } else { halfpq })) - 1;
                }
                if truth(q2) && (q1 != q2) {
                    let s = T::DQSCALE.at(q1 - 1);
                    for k in 1..8 {
                        block.set(
                            b + (k << sh),
                            block.at(b + (k << sh))
                                + (((((ac.at(acv + k)).wrapping_mul(q2)).wrapping_mul(s)
                                    + 131072)
                                    | 0)
                                    >> 18),
                        );
                    }
                } else {
                    for k in 1..8 {
                        block.set(b + (k << sh), block.at(b + (k << sh)) + ac.at(acv + k));
                    }
                }
            }
            for k in 1..8 {
                ac.set(ac2 + k, block.at(b + (k << left_sh)));
                ac.set((ac2 + k) + 8, block.at(b + (k << top_sh)));
            }
            for k in 1..64 {
                if truth(block.at(b + k)) {
                    block.set(b + k, block.at(b + k) * scale);
                    if !truth(self.pquantizer) {
                        block.set(
                            b + k,
                            block.at(b + k) + (if block.at(b + k) < 0 { -quant } else { quant }),
                        );
                    }
                }
            }
        } else {
            ac.fill_range(0, ac2, ac2 + 16);
            if truth(use_pred) {
                let sh: i32;
                let mut dst = ac2;
                if truth(dir) {
                    sh = left_sh;
                } else {
                    sh = top_sh;
                    acv = acv + 8;
                    dst = dst + 8;
                }
                ac.copy_within(dst, acv, acv + 8);
                q1 = (((q1).abs() * 2) + (if q1 < 0 { 0 } else { halfpq })) - 1;
                if q1 < 1 {
                    return INVALID_DATA;
                }
                if truth(q2) {
                    q2 = (((q2).abs() * 2) + (if q2 < 0 { 0 } else { halfpq })) - 1;
                }
                if truth(q2) && (q1 != q2) {
                    let s = T::DQSCALE.at(q1 - 1);
                    for k in 1..8 {
                        ac.set(
                            dst + k,
                            ((((ac.at(dst + k)).wrapping_mul(q2)).wrapping_mul(s) + 131072) | 0)
                                >> 18,
                        );
                    }
                }
                for k in 1..8 {
                    let p = b + (k << sh);
                    block.set(p, ac.at(dst + k) * scale);
                    if (!truth(self.pquantizer)) && truth(block.at(p)) {
                        block.set(
                            p,
                            block.at(p) + (if block.at(p) < 0 { -quant } else { quant }),
                        );
                    }
                }
            }
        }
        return 0;
    }
    #[inline(always)]
    unsafe fn intra_block(
        &mut self,
        b: i32,
        n: i32,
        coded: i32,
        mquant: i32,
        codingset: i32,
    ) -> i32 {
        let block = self.blocks;
        let a_avail = self.a_avail;
        let c_avail = self.c_avail;
        let mbs = self.mbs;
        let raw_pos = self.mb_x + (self.mb_y * mbs);
        let mb_pos = mbs + raw_pos;
        let mut use_pred = self.ac_pred;
        block.fill_range(0, b, b + 64);
        let mut quant = (mquant).abs();
        quant = if quant > 31 { 31 } else { quant };
        {
            let value = {
                let value = T::DC_SCALE.at(quant);
                self.c_dc_scale = value;
                value
            };
            self.y_dc_scale = value;
            value
        };
        let mut dcdiff = self.dc_diff(n, quant);
        dcdiff = dcdiff + self.pred_dc(n, a_avail, c_avail);
        let mut dir = self.dc_dir;
        let xy = self.origin + self.bi.at(n);
        self.dc_val.set(xy, dcdiff);
        block.set(
            b,
            dcdiff
                * (if n < 4 {
                    self.y_dc_scale
                } else {
                    self.c_dc_scale
                }),
        );
        if !truth(a_avail) {
            dir = 1;
        }
        if !truth(c_avail) {
            dir = 0;
        }
        if (!truth(a_avail)) && (!truth(c_avail)) {
            use_pred = 0;
        }
        let ac = self.ac_val;
        let ac2 = xy * 16;
        let scale = (quant * 2) + (if mquant < 0 { 0 } else { self.halfpq });
        let acv = if truth(dir) {
            ac2 - 16
        } else {
            ac2 - (16 * self.wrap.at(n))
        };
        let mut q1 = self.qscale.at(mb_pos);
        let mut q2 = 0;
        if (truth(dir) && truth(c_avail)) && truth(raw_pos) {
            q2 = self.qscale.at(mb_pos - 1);
        }
        if ((!truth(dir)) && truth(a_avail)) && (raw_pos >= mbs) {
            q2 = self.qscale.at(mb_pos - mbs);
        }
        if truth(dir) && (n == 1) {
            q2 = q1;
        }
        if (!truth(dir)) && (n == 2) {
            q2 = q1;
        }
        if n == 3 {
            q2 = q1;
        }
        let left_sh = self.left_sh;
        let top_sh = self.top_sh;
        let halfpq = self.halfpq;

        if truth(coded) {
            let zz = self.zz8x8.at(0);
            let mut i = 1;
            let mut last = 0;
            while !truth(last) {
                let ret = self.ac_coeff(codingset);
                if ret < 0 {
                    return ret;
                }
                last = self.ac_last;
                i = i + self.ac_run;
                if i > 63 {
                    break;
                }
                block.set(
                    b + zz.at({
                        let previous = i;
                        i = i + 1;
                        previous
                    }),
                    self.ac_value,
                );
            }
            if truth(use_pred) {
                q1 = (((q1).abs() * 2) + (if q1 < 0 { 0 } else { halfpq })) - 1;
                if q1 < 1 {
                    return INVALID_DATA;
                }
                if truth(q2) {
                    q2 = (((q2).abs() * 2) + (if q2 < 0 { 0 } else { halfpq })) - 1;
                }
                if truth(q2) && (q1 != q2) {
                    if truth(dir) {
                        for k in 1..8 {
                            block.set(
                                b + (k << left_sh),
                                block.at(b + (k << left_sh))
                                    + (((((ac.at(acv + k)).wrapping_mul(q2))
                                        .wrapping_mul(T::DQSCALE.at(q1 - 1))
                                        + 131072)
                                        | 0)
                                        >> 18),
                            );
                        }
                    } else {
                        for k in 1..8 {
                            block.set(
                                b + (k << top_sh),
                                block.at(b + (k << top_sh))
                                    + (((((ac.at((acv + k) + 8)).wrapping_mul(q2))
                                        .wrapping_mul(T::DQSCALE.at(q1 - 1))
                                        + 131072)
                                        | 0)
                                        >> 18),
                            );
                        }
                    }
                } else {
                    if truth(dir) {
                        for k in 1..8 {
                            block.set(
                                b + (k << left_sh),
                                block.at(b + (k << left_sh)) + ac.at(acv + k),
                            );
                        }
                    } else {
                        for k in 1..8 {
                            block.set(
                                b + (k << top_sh),
                                block.at(b + (k << top_sh)) + ac.at((acv + k) + 8),
                            );
                        }
                    }
                }
            }
            for k in 1..8 {
                ac.set(ac2 + k, block.at(b + (k << left_sh)));
                ac.set((ac2 + k) + 8, block.at(b + (k << top_sh)));
            }
            for k in 1..64 {
                if truth(block.at(b + k)) {
                    block.set(b + k, block.at(b + k) * scale);
                    if !truth(self.pquantizer) {
                        block.set(
                            b + k,
                            block.at(b + k) + (if block.at(b + k) < 0 { -quant } else { quant }),
                        );
                    }
                }
            }
        } else {
            ac.fill_range(0, ac2, ac2 + 16);
            if truth(use_pred) {
                let h = if truth(dir) { 0 } else { 8 };
                ac.copy_within(ac2 + h, acv + h, (acv + h) + 8);
                q1 = (((q1).abs() * 2) + (if q1 < 0 { 0 } else { halfpq })) - 1;
                if q1 < 1 {
                    return INVALID_DATA;
                }
                if truth(q2) {
                    q2 = (((q2).abs() * 2) + (if q2 < 0 { 0 } else { halfpq })) - 1;
                }
                if truth(q2) && (q1 != q2) {
                    for k in 1..8 {
                        ac.set(
                            (ac2 + h) + k,
                            ((((ac.at((ac2 + h) + k)).wrapping_mul(q2))
                                .wrapping_mul(T::DQSCALE.at(q1 - 1))
                                + 131072)
                                | 0)
                                >> 18,
                        );
                    }
                }
                let sh = if truth(dir) { left_sh } else { top_sh };
                for k in 1..8 {
                    let p = b + (k << sh);
                    block.set(p, ac.at((ac2 + h) + k) * scale);
                    if (!truth(self.pquantizer)) && truth(block.at(p)) {
                        block.set(
                            p,
                            block.at(p) + (if block.at(p) < 0 { -quant } else { quant }),
                        );
                    }
                }
            }
        }
        return 0;
    }
    #[inline(always)]
    unsafe fn p_block(
        &mut self,
        b: i32,
        n: i32,
        mquant: i32,
        ttmb: i32,
        first_block: i32,
        dst: B8,
        d: i32,
        ls: i32,
    ) -> i32 {
        let block = self.blocks;
        let quant = (mquant).abs();
        let cs = self.codingset2;
        block.fill_range(0, b, b + 64);
        let mut ttblk = ttmb & 7;
        let mut subblkpat = 0;
        let mut pat = 0;
        if ttmb == (-1) {
            ttblk =
                TTBLK_TO_TT.at((self.tt_index * 8) + self.gb.vlc(T::TTBLK.at(self.tt_index), 5, 1));
        }
        if ttblk == TT_4X4 {
            subblkpat = !(self.gb.vlc(T::SUBBLKPAT.at(self.tt_index), 6, 1) + 1);
        }
        if ((ttblk != TT_8X8) && (ttblk != TT_4X4))
            && ((truth(self.ttmbf)
                || (((ttmb != (-1)) && truth(ttmb & 8)) && (!truth(first_block))))
                || ((!truth(self.res_rtm)) && (!truth(first_block))))
        {
            subblkpat = self.gb.decode012();
            if truth(subblkpat) {
                subblkpat = subblkpat ^ 3;
            }
            if (ttblk == TT_8X4_TOP) || (ttblk == TT_8X4_BOTTOM) {
                ttblk = TT_8X4;
            }
            if (ttblk == TT_4X8_RIGHT) || (ttblk == TT_4X8_LEFT) {
                ttblk = TT_4X8;
            }
        }
        let scale = (quant * 2) + (if mquant < 0 { 0 } else { self.halfpq });
        if (ttblk == TT_8X4_TOP) || (ttblk == TT_8X4_BOTTOM) {
            subblkpat = 2 - (if ttblk == TT_8X4_TOP { 1 } else { 0 });
            ttblk = TT_8X4;
        }
        if (ttblk == TT_4X8_RIGHT) || (ttblk == TT_4X8_LEFT) {
            subblkpat = 2 - (if ttblk == TT_4X8_LEFT { 1 } else { 0 });
            ttblk = TT_4X8;
        }
        let pquantizer = self.pquantizer;

        match ttblk {
            TT_8X8 => {
                pat = 15;
                let i = self.p_coefficients(
                    b,
                    cs,
                    quant,
                    scale,
                    pquantizer,
                    &self.zz8x8.at(0),
                    0,
                    63,
                    0,
                );
                if i < 0 {
                    return i;
                }
                if i == 1 {
                    inv_trans8x8_dc(dst, d, ls, block.at(b));
                } else {
                    inv_trans8x8(block, b);
                    add_pixels_clamped(block, b, dst, d, ls);
                }
            }
            TT_4X4 => {
                pat = (!subblkpat) & 15;
                for j in 0..4 {
                    let off = ((j & 1) * 4) + ((j & 2) * 16);
                    let i = self.p_coefficients(
                        b,
                        cs,
                        quant,
                        scale,
                        pquantizer,
                        &T::ZZ_4X4,
                        off,
                        15,
                        subblkpat & (1 << (3 - j)),
                    );
                    if i < 0 {
                        return i;
                    }
                    if !truth(subblkpat & (1 << (3 - j))) {
                        let o = (d + ((j & 1) * 4)) + (((j & 2) * 2) * ls);
                        if i == 1 {
                            inv_trans4x4_dc(dst, o, ls, block.at(b + off));
                        } else {
                            inv_trans4x4(dst, o, ls, block, b + off);
                        }
                    }
                }
            }
            TT_8X4 => {
                pat = (!(((subblkpat & 2) * 6) + ((subblkpat & 1) * 3))) & 15;
                for j in 0..2 {
                    let off = j * 32;
                    let i = self.p_coefficients(
                        b,
                        cs,
                        quant,
                        scale,
                        pquantizer,
                        &self.zz8x4,
                        off,
                        31,
                        subblkpat & (1 << (1 - j)),
                    );
                    if i < 0 {
                        return i;
                    }
                    if !truth(subblkpat & (1 << (1 - j))) {
                        let o = d + ((j * 4) * ls);
                        if i == 1 {
                            inv_trans8x4_dc(dst, o, ls, block.at(b + off));
                        } else {
                            inv_trans8x4(dst, o, ls, block, b + off);
                        }
                    }
                }
            }
            TT_4X8 => {
                pat = (!(subblkpat * 5)) & 15;
                for j in 0..2 {
                    let off = j * 4;
                    let i = self.p_coefficients(
                        b,
                        cs,
                        quant,
                        scale,
                        pquantizer,
                        &self.zz4x8,
                        off,
                        31,
                        subblkpat & (1 << (1 - j)),
                    );
                    if i < 0 {
                        return i;
                    }
                    if !truth(subblkpat & (1 << (1 - j))) {
                        let o = d + (j * 4);
                        if i == 1 {
                            inv_trans4x8_dc(dst, o, ls, block.at(b + off));
                        } else {
                            inv_trans4x8(dst, o, ls, block, b + off);
                        }
                    }
                }
            }
            _ => {}
        }
        self.tt_out = self.tt_out | (ttblk << (n * 4));
        return pat;
    }
    #[inline(always)]
    unsafe fn put_blocks(&mut self, signed: bool) {
        let cur = self.cur;

        let o = self.origin;
        let mt = self.mb_type;
        let ls = self.ls;
        let uvls = self.uvls;
        let b8 = self.b8;
        let mbs = self.mbs;
        let blocks = self.blocks;
        let last_col = self.mb_x == (self.mbw - 1);
        if !truth(self.first_slice_line) {
            if truth(self.mb_x) {
                for i in 0..6 {
                    if truth(mt.at(o
                        + (if i > 3 {
                            (self.bi.at(i) - mbs) - 1
                        } else {
                            (self.bi.at(i) - (2 * b8)) - 2
                        })))
                    {
                        put_mode(
                            blocks,
                            self.blk(self.topleft_blk, i),
                            self.plane(cur, i),
                            if i > 3 {
                                (self.dest1 - (8 * uvls)) - 8
                            } else {
                                (self.dest0 + ((((i & 2) - 4) * 4) * ls)) + (((i & 1) - 2) * 8)
                            },
                            if i > 3 { uvls } else { ls },
                            signed,
                        );
                    }
                }
            }
            if last_col {
                for i in 0..6 {
                    if truth(mt.at(o
                        + (if i > 3 {
                            self.bi.at(i) - mbs
                        } else {
                            self.bi.at(i) - (2 * b8)
                        })))
                    {
                        put_mode(
                            blocks,
                            self.blk(self.top_blk, i),
                            self.plane(cur, i),
                            if i > 3 {
                                self.dest1 - (8 * uvls)
                            } else {
                                (self.dest0 + ((((i & 2) - 4) * 4) * ls)) + ((i & 1) * 8)
                            },
                            if i > 3 { uvls } else { ls },
                            signed,
                        );
                    }
                }
            }
        }
        if self.mb_y == (self.end_mb_y - 1) {
            if truth(self.mb_x) {
                for i in 0..6 {
                    if truth(mt.at(o
                        + (if i > 3 {
                            self.bi.at(i) - 1
                        } else {
                            self.bi.at(i) - 2
                        })))
                    {
                        put_mode(
                            blocks,
                            self.blk(self.left_blk, i),
                            self.plane(cur, i),
                            if i > 3 {
                                self.dest1 - 8
                            } else {
                                (self.dest0 + (((i & 2) * 4) * ls)) + (((i & 1) - 2) * 8)
                            },
                            if i > 3 { uvls } else { ls },
                            signed,
                        );
                    }
                }
            }
            if last_col {
                for i in 0..6 {
                    if truth(mt.at(o + self.bi.at(i))) {
                        put_mode(
                            blocks,
                            self.blk(self.cur_blk, i),
                            self.plane(cur, i),
                            if i > 3 {
                                self.dest1
                            } else {
                                (self.dest0 + (((i & 2) * 4) * ls)) + ((i & 1) * 8)
                            },
                            if i > 3 { uvls } else { ls },
                            signed,
                        );
                    }
                }
            }
        }
    }
    #[inline(always)]
    unsafe fn pred_mv(&mut self, n: i32, mut dmv_x: i32, mut dmv_y: i32, mv1: bool) {
        let motion = self.motion;
        let wrap = self.b8;
        let xy = 4 + self.bi.at(n);
        let mt = self.origin + self.bi.at(n);
        if !truth(self.quarter_sample) {
            dmv_x = dmv_x * 2;
            dmv_y = dmv_y * 2;
        }
        if truth(self.mb_intra) {
            {
                let value = {
                    let value = 0;
                    self.mv.set((n * 2) + 1, value);
                    value
                };
                self.mv.set(n * 2, value);
                value
            };
            {
                let value = {
                    let value = 0;
                    motion.set((xy * 2) + 1, value);
                    value
                };
                motion.set(xy * 2, value);
                value
            };
            if mv1 {
                motion.fill_range(0, (xy + 1) * 2, (xy + 2) * 2);
                motion.fill_range(0, (xy + wrap) * 2, ((xy + wrap) + 2) * 2);
                let m = ((2 * self.mbs) + self.mb_x) * 2;
                {
                    let value = {
                        let value = 0;
                        self.luma_mv.set(m + 1, value);
                        value
                    };
                    self.luma_mv.set(m, value);
                    value
                };
            }
            return;
        }
        let a_valid = ((!truth(self.first_slice_line)) || (n == 2)) || (n == 3);
        let mut b_valid = a_valid;
        let c_valid = ((self.mb_x != 0) || (n == 1)) || (n == 3);
        let mbw = self.mbw;
        let off: i32;
        if mv1 {
            off = if self.mb_x == (mbw - 1) { -1 } else { 2 };
            b_valid = b_valid && (mbw > 1);
        } else {
            match n {
                0 => {
                    off = if truth(self.res_rtm) {
                        if truth(self.mb_x) {
                            -1
                        } else {
                            1
                        }
                    } else {
                        if truth(self.mb_x) {
                            -1
                        } else {
                            ((2 * mbw) - wrap) - 1
                        }
                    };
                }
                1 => {
                    off = if self.mb_x == (mbw - 1) { -1 } else { 1 };
                }
                2 => {
                    off = 1;
                }
                _ => {
                    off = -1;
                }
            }
        }
        let mut ax = 0;
        let mut ay = 0;
        let mut bx = 0;
        let mut by = 0;
        let mut cx = 0;
        let mut cy = 0;
        let mut count = 0;
        if a_valid {
            ax = motion.at((xy - wrap) * 2);
            ay = motion.at(((xy - wrap) * 2) + 1);
            count = count + 1;
        }
        if b_valid {
            bx = motion.at(((xy - wrap) + off) * 2);
            by = motion.at((((xy - wrap) + off) * 2) + 1);
            count = count + 1;
        }
        if c_valid {
            cx = motion.at((xy - 1) * 2);
            cy = motion.at(((xy - 1) * 2) + 1);
            count = count + 1;
        }
        let mut px: i32;
        let mut py: i32;
        if a_valid {
            px = ax;
            py = ay;
        } else {
            if c_valid {
                px = cx;
                py = cy;
            } else {
                if b_valid {
                    px = bx;
                    py = by;
                } else {
                    {
                        let value = {
                            let value = 0;
                            py = value;
                            value
                        };
                        px = value;
                        value
                    };
                }
            }
        }
        if count > 1 {
            px = mid_pred(ax, bx, cx);
            py = mid_pred(ay, by, cy);
        }
        let lim = if mv1 { -60 } else { -28 };
        let qx = (self.mb_x << 6) + (if (n == 1) || (n == 3) { 32 } else { 0 });
        let qy = (self.mb_y << 6) + (if (n == 2) || (n == 3) { 32 } else { 0 });
        let x_limit = (mbw << 6) - 4;
        let y_limit = (self.mbh << 6) - 4;
        if (qx + px) < lim {
            px = lim - qx;
        }
        if (qy + py) < lim {
            py = lim - qy;
        }
        if (qx + px) > x_limit {
            px = x_limit - qx;
        }
        if (qy + py) > y_limit {
            py = y_limit - qy;
        }
        if a_valid && c_valid {
            let is_intra = self.mb_type;
            let mut sum = if truth(is_intra.at(mt - wrap)) {
                (px).abs() + (py).abs()
            } else {
                (px - ax).abs() + (py - ay).abs()
            };
            if sum > 32 {
                if truth(self.gb.bit()) {
                    px = ax;
                    py = ay;
                } else {
                    px = cx;
                    py = cy;
                }
            } else {
                sum = if truth(is_intra.at(mt - 1)) {
                    (px).abs() + (py).abs()
                } else {
                    (px - cx).abs() + (py - cy).abs()
                };
                if sum > 32 {
                    if truth(self.gb.bit()) {
                        px = ax;
                        py = ay;
                    } else {
                        px = cx;
                        py = cy;
                    }
                }
            }
        }
        let rx = self.range_x;
        let ry = self.range_y;
        let mx = (((px + dmv_x) + rx) & ((rx << 1) - 1)) - rx;
        let my = (((py + dmv_y) + ry) & ((ry << 1) - 1)) - ry;
        self.mv.set(n * 2, mx);
        self.mv.set((n * 2) + 1, my);
        motion.set(xy * 2, mx);
        motion.set((xy * 2) + 1, my);
        if mv1 {
            for k in [(xy + 1), (xy + wrap), ((xy + wrap) + 1)] {
                motion.set(k * 2, mx);
                motion.set((k * 2) + 1, my);
            }
        }
    }
    #[inline(always)]
    unsafe fn emulated_edge(
        &mut self,
        dst: B8,
        mut d: i32,
        src: B8,
        stride: i32,
        bw: i32,
        bh: i32,
        x0: i32,
        y0: i32,
        w: i32,
        h: i32,
    ) {
        for j in 0..bh {
            let sy = clip(y0 + j, 0, h - 1) * stride;
            for i in 0..bw {
                dst.set(d + i, src.at(sy + clip(x0 + i, 0, w - 1)));
            }
            let _ = {
                d = d + stride;
                d
            };
        }
    }
    #[inline(always)]
    unsafe fn apply_lut(&mut self, buf: B8, mut o: i32, stride: i32, k: i32, lut: B8) {
        for _j in 0..k {
            for i in 0..k {
                buf.set(o + i, lut.at(buf.at(o + i)));
            }
            let _ = {
                o = o + stride;
                o
            };
        }
    }
    #[inline(always)]
    unsafe fn chroma_round(&mut self, uv: i32) -> i32 {
        return if truth(self.fastuvmc) {
            uv + (if uv < 0 { uv & 1 } else { -(uv & 1) })
        } else {
            uv
        };
    }
    #[inline(always)]
    unsafe fn mc1mv(&mut self) {
        let last = self.last;
        if !truth(last) {
            return;
        }
        let cur = self.cur;
        let ls = self.ls;
        let uvls = self.uvls;
        let ms = self.mspel;
        let h_edge = self.h_edge;
        let v_edge = self.v_edge;
        let mx = self.mv.at(0);
        let my = self.mv.at(1);
        let mut uvmx = (mx + (if (mx & 3) == 3 { 1 } else { 0 })) >> 1;
        let mut uvmy = (my + (if (my & 3) == 3 { 1 } else { 0 })) >> 1;
        let m = ((2 * self.mbs) + self.mb_x) * 2;
        self.luma_mv.set(m, uvmx);
        self.luma_mv.set(m + 1, uvmy);
        uvmx = self.chroma_round(uvmx);
        uvmy = self.chroma_round(uvmy);
        let mut src_x = (self.mb_x * 16) + (mx >> 2);
        let mut src_y = (self.mb_y * 16) + (my >> 2);
        let mut uv_x = (self.mb_x * 8) + (uvmx >> 2);
        let mut uv_y = (self.mb_y * 8) + (uvmy >> 2);
        if !truth(self.advanced) {
            src_x = clip(src_x, -16, self.mbw * 16);
            src_y = clip(src_y, -16, self.mbh * 16);
            uv_x = clip(uv_x, -8, self.mbw * 8);
            uv_y = clip(uv_y, -8, self.mbh * 8);
        } else {
            src_x = clip(src_x, -17, self.coded_width);
            uv_x = clip(uv_x, -8, self.coded_width >> 1);
            src_y = clip(src_y, -18, self.coded_height + 1);
            uv_y = clip(uv_y, -8, self.coded_height >> 1);
        }
        let mut y_src = last.y;
        let mut ys = (src_y * ls) + src_x;
        let mut u_src = last.cb;
        let mut v_src = last.cr;
        let mut us = (uv_y * uvls) + uv_x;
        let mut vs = us;
        if (((truth(self.use_ic) || (h_edge < 22)) || (v_edge < 22))
            || (((((src_x - ms) as u32 >> (0)) as i32) as u32)
                > ((((((h_edge - (mx & 3)) - 16) - (ms * 3)) as u32 >> (0)) as i32) as u32)))
            || (((((src_y - 1) as u32 >> (0)) as i32) as u32)
                > ((((((v_edge - (my & 3)) - 16) - 3) as u32 >> (0)) as i32) as u32))
        {
            let emu = self.emu;
            let ubuf = 19 * ls;
            let vbuf = ubuf + (9 * uvls);
            let k = 17 + (ms * 2);
            self.emulated_edge(
                emu,
                0,
                last.y,
                ls,
                k,
                k,
                src_x - ms,
                src_y - ms,
                h_edge,
                v_edge,
            );
            self.emulated_edge(
                emu,
                ubuf,
                last.cb,
                uvls,
                9,
                9,
                uv_x,
                uv_y,
                h_edge >> 1,
                v_edge >> 1,
            );
            self.emulated_edge(
                emu,
                vbuf,
                last.cr,
                uvls,
                9,
                9,
                uv_x,
                uv_y,
                h_edge >> 1,
                v_edge >> 1,
            );
            if truth(self.use_ic) {
                self.apply_lut(emu, 0, ls, k, self.lut_y);
                self.apply_lut(emu, ubuf, uvls, 9, self.lut_uv);
                self.apply_lut(emu, vbuf, uvls, 9, self.lut_uv);
            }
            {
                let value = {
                    let value = {
                        let value = emu;
                        v_src = value;
                        value
                    };
                    u_src = value;
                    value
                };
                y_src = value;
                value
            };
            ys = ms * (1 + ls);
            us = ubuf;
            vs = vbuf;
        }
        let no_rnd = self.rnd != 0;
        if truth(ms) {
            mspel_mc(
                cur.y,
                self.dest0,
                y_src,
                ys,
                ls,
                16,
                mx & 3,
                my & 3,
                self.rnd,
                false,
            );
        } else {
            hpel_mc(
                cur.y,
                self.dest0,
                y_src,
                ys,
                ls,
                16,
                (my & 2) | ((mx & 2) >> 1),
                no_rnd,
                false,
            );
        }
        uvmx = (uvmx & 3) << 1;
        uvmy = (uvmy & 3) << 1;
        chroma_mc(
            cur.cb, self.dest1, u_src, us, uvls, 8, 8, uvmx, uvmy, no_rnd, false,
        );
        chroma_mc(
            cur.cr, self.dest1, v_src, vs, uvls, 8, 8, uvmx, uvmy, no_rnd, false,
        );
    }
    #[inline(always)]
    unsafe fn mc4mv_luma(&mut self, n: i32) {
        let last = self.last;
        if !truth(last) {
            return;
        }
        let ls = self.ls;
        let ms = self.mspel;
        let h_edge = self.h_edge;
        let v_edge = self.v_edge;
        let mx = self.mv.at(n * 2);
        let my = self.mv.at((n * 2) + 1);
        let off = ((ls * 4) * (n & 2)) + ((n & 1) * 8);
        let mut src_x = ((self.mb_x * 16) + ((n & 1) * 8)) + (mx >> 2);
        let mut src_y = ((self.mb_y * 16) + ((n & 2) * 4)) + (my >> 2);
        if !truth(self.advanced) {
            src_x = clip(src_x, -16, self.mbw * 16);
            src_y = clip(src_y, -16, self.mbh * 16);
        } else {
            src_x = clip(src_x, -17, self.coded_width);
            src_y = clip(src_y, -18, self.coded_height + 1);
        }
        let mut src = last.y;
        let mut s = (src_y * ls) + src_x;
        if (((truth(self.use_ic) || (h_edge < 13)) || (v_edge < 23))
            || (((((src_x - ms) as u32 >> (0)) as i32) as u32)
                > ((((((h_edge - (mx & 3)) - 8) - (ms * 2)) as u32 >> (0)) as i32) as u32)))
            || (((((src_y - ms) as u32 >> (0)) as i32) as u32)
                > (((((v_edge - (my & 3)) - (8 + (ms * 2))) as u32 >> (0)) as i32) as u32))
        {
            let k = 9 + (ms * 2);
            let emu = self.emu;
            self.emulated_edge(
                emu,
                0,
                last.y,
                ls,
                k,
                k,
                src_x - ms,
                src_y - ms,
                h_edge,
                v_edge,
            );
            if truth(self.use_ic) {
                self.apply_lut(emu, 0, ls, k, self.lut_y);
            }
            src = emu;
            s = ms * (1 + ls);
        }
        let cur = self.cur;
        if truth(ms) {
            mspel_mc(
                cur.y,
                self.dest0 + off,
                src,
                s,
                ls,
                8,
                mx & 3,
                my & 3,
                self.rnd,
                false,
            );
        } else {
            hpel_mc(
                cur.y,
                self.dest0 + off,
                src,
                s,
                ls,
                8,
                (my & 2) | ((mx & 2) >> 1),
                self.rnd != 0,
                false,
            );
        }
    }
    #[inline(always)]
    unsafe fn mc4mv_chroma(&mut self) {
        let last = self.last;
        if !truth(last) {
            return;
        }
        let mt = self.mb_type;
        let o = self.origin;

        let idx = (((if truth(mt.at(o + self.bi.at(0))) {
            0
        } else {
            1
        }) | (if truth(mt.at(o + self.bi.at(1))) {
            0
        } else {
            2
        })) | (if truth(mt.at(o + self.bi.at(2))) {
            0
        } else {
            4
        })) | (if truth(mt.at(o + self.bi.at(3))) {
            0
        } else {
            8
        });
        let mut tx: i32;
        let mut ty: i32;
        match POPCOUNT4.at(idx) {
            4 => {
                tx = median4(self.mv.at(0), self.mv.at(2), self.mv.at(4), self.mv.at(6));
                ty = median4(self.mv.at(1), self.mv.at(3), self.mv.at(5), self.mv.at(7));
            }
            3 => {
                let i0 = if idx > 13 { 1 } else { 0 };
                let i1 = 1 + (if idx > 11 { 1 } else { 0 });
                let i2 = 2 + (if idx > 7 { 1 } else { 0 });
                tx = mid_pred(self.mv.at(i0 * 2), self.mv.at(i1 * 2), self.mv.at(i2 * 2));
                ty = mid_pred(
                    self.mv.at((i0 * 2) + 1),
                    self.mv.at((i1 * 2) + 1),
                    self.mv.at((i2 * 2) + 1),
                );
            }
            2 => {
                let a = CHROMA_INDEX2.at(idx) >> 4;
                let b = CHROMA_INDEX2.at(idx) & 15;
                tx = ((self.mv.at(a * 2) + self.mv.at(b * 2)) / 2) | 0;
                ty = ((self.mv.at((a * 2) + 1) + self.mv.at((b * 2) + 1)) / 2) | 0;
            }
            _ => {
                let m = ((2 * self.mbs) + self.mb_x) * 2;
                {
                    let value = {
                        let value = 0;
                        self.luma_mv.set(m + 1, value);
                        value
                    };
                    self.luma_mv.set(m, value);
                    value
                };
                return;
            }
        }
        tx = (tx << 16) >> 16;
        ty = (ty << 16) >> 16;
        let mut uvmx = (tx + (if (tx & 3) == 3 { 1 } else { 0 })) >> 1;
        let mut uvmy = (ty + (if (ty & 3) == 3 { 1 } else { 0 })) >> 1;
        let m = ((2 * self.mbs) + self.mb_x) * 2;
        self.luma_mv.set(m, uvmx);
        self.luma_mv.set(m + 1, uvmy);
        uvmx = self.chroma_round(uvmx);
        uvmy = self.chroma_round(uvmy);
        let mut uv_x = (self.mb_x * 8) + (uvmx >> 2);
        let mut uv_y = (self.mb_y * 8) + (uvmy >> 2);
        if !truth(self.advanced) {
            uv_x = clip(uv_x, -8, self.mbw * 8);
            uv_y = clip(uv_y, -8, self.mbh * 8);
        } else {
            uv_x = clip(uv_x, -8, self.coded_width >> 1);
            uv_y = clip(uv_y, -8, self.coded_height >> 1);
        }
        let uvls = self.uvls;
        let h_edge = self.h_edge;
        let v_edge = self.v_edge;
        let mut u_src = last.cb;
        let mut v_src = last.cr;
        let mut us = (uv_y * uvls) + uv_x;
        let mut vs = us;
        if (((truth(self.use_ic) || (h_edge < 18)) || (v_edge < 18))
            || (((((uv_x) as u32 >> (0)) as i32) as u32)
                > (((((h_edge >> 1) - 9) as u32 >> (0)) as i32) as u32)))
            || (((((uv_y) as u32 >> (0)) as i32) as u32)
                > (((((v_edge >> 1) - 9) as u32 >> (0)) as i32) as u32))
        {
            let emu = self.emu;
            self.emulated_edge(
                emu,
                0,
                last.cb,
                uvls,
                9,
                9,
                uv_x,
                uv_y,
                h_edge >> 1,
                v_edge >> 1,
            );
            self.emulated_edge(
                emu,
                16,
                last.cr,
                uvls,
                9,
                9,
                uv_x,
                uv_y,
                h_edge >> 1,
                v_edge >> 1,
            );
            if truth(self.use_ic) {
                self.apply_lut(emu, 0, uvls, 9, self.lut_uv);
                self.apply_lut(emu, 16, uvls, 9, self.lut_uv);
            }
            {
                let value = {
                    let value = emu;
                    v_src = value;
                    value
                };
                u_src = value;
                value
            };
            us = 0;
            vs = 16;
        }
        let cur = self.cur;
        let no_rnd = self.rnd != 0;
        uvmx = (uvmx & 3) << 1;
        uvmy = (uvmy & 3) << 1;
        chroma_mc(
            cur.cb, self.dest1, u_src, us, uvls, 8, 8, uvmx, uvmy, no_rnd, false,
        );
        chroma_mc(
            cur.cr, self.dest1, v_src, vs, uvls, 8, 8, uvmx, uvmy, no_rnd, false,
        );
    }
    #[inline(always)]
    unsafe fn i_loop_filter(&mut self) {
        let ls = self.ls;
        let uvls = self.uvls;
        let d0 = self.dest0;
        let d1 = self.dest1;
        let x = self.mb_x;
        let y = self.mb_y;
        let last_col = x == (self.mbw - 1);

        if !truth(self.first_slice_line) {
            let flags = if y == (self.start_mb_y + 1) {
                TOP_EDGE
            } else {
                0
            };
            if truth(x) {
                {
                    for i in 0..6 {
                        self.i_v(
                            if i > 3 {
                                (d1 - (8 * uvls)) - 8
                            } else {
                                (d0 - (16 * ls)) - 16
                            },
                            flags,
                            i,
                        );
                    }
                };
            }
            if last_col {
                {
                    for i in 0..6 {
                        self.i_v(
                            if i > 3 {
                                d1 - (8 * uvls)
                            } else {
                                d0 - (16 * ls)
                            },
                            flags,
                            i,
                        );
                    }
                };
            }
        }
        if y == (self.end_mb_y - 1) {
            let flags = if truth(self.first_slice_line) {
                TOP_EDGE | BOTTOM_EDGE
            } else {
                BOTTOM_EDGE
            };
            if truth(x) {
                {
                    for i in 0..6 {
                        self.i_v(if i > 3 { d1 - 8 } else { d0 - 16 }, flags, i);
                    }
                };
            }
            if last_col {
                {
                    for i in 0..6 {
                        self.i_v(if i > 3 { d1 } else { d0 }, flags, i);
                    }
                };
            }
        }
        let right_flags = if x == 0 {
            LEFT_EDGE | RIGHT_EDGE
        } else {
            RIGHT_EDGE
        };
        if y >= (self.start_mb_y + 2) {
            if truth(x) {
                {
                    for i in 0..6 {
                        self.i_h(
                            if i > 3 {
                                (d1 - (16 * uvls)) - 8
                            } else {
                                (d0 - (32 * ls)) - 16
                            },
                            if x == 1 { LEFT_EDGE } else { 0 },
                            i,
                        );
                    }
                };
            }
            if last_col {
                {
                    for i in 0..6 {
                        self.i_h(
                            if i > 3 {
                                d1 - (16 * uvls)
                            } else {
                                d0 - (32 * ls)
                            },
                            right_flags,
                            i,
                        );
                    }
                };
            }
        }
        if y == (self.end_mb_y - 1) {
            if y >= (self.start_mb_y + 1) {
                if truth(x) {
                    {
                        for i in 0..6 {
                            self.i_h(
                                if i > 3 {
                                    (d1 - (8 * uvls)) - 8
                                } else {
                                    (d0 - (16 * ls)) - 16
                                },
                                if x == 1 { LEFT_EDGE } else { 0 },
                                i,
                            );
                        }
                    };
                }
                if last_col {
                    {
                        for i in 0..6 {
                            self.i_h(
                                if i > 3 {
                                    d1 - (8 * uvls)
                                } else {
                                    d0 - (16 * ls)
                                },
                                right_flags,
                                i,
                            );
                        }
                    };
                }
            }
            if truth(x) {
                {
                    for i in 0..6 {
                        self.i_h(
                            if i > 3 { d1 - 8 } else { d0 - 16 },
                            if x == 1 { LEFT_EDGE } else { 0 },
                            i,
                        );
                    }
                };
            }
            if last_col {
                {
                    for i in 0..6 {
                        self.i_h(if i > 3 { d1 } else { d0 }, right_flags, i);
                    }
                };
            }
        }
    }
    #[inline(always)]
    unsafe fn i_h(&mut self, dest: i32, flags: i32, n: i32) {
        if truth(n & 2) {
            return;
        }
        if (!truth(flags & LEFT_EDGE)) || ((n & 5) == 1) {
            let cur = self.cur;
            if n > 3 {
                h_loop_filter(self.plane(cur, n), dest, self.uvls, 8, self.pq);
            } else {
                h_loop_filter(
                    cur.y,
                    (dest + (((n & 2) * 4) * self.ls)) + ((n & 1) * 8),
                    self.ls,
                    16,
                    self.pq,
                );
            }
        }
    }
    #[inline(always)]
    unsafe fn i_v(&mut self, dest: i32, flags: i32, n: i32) {
        if (n & 5) == 1 {
            return;
        }
        if (!truth(flags & TOP_EDGE)) || truth(n & 2) {
            let cur = self.cur;
            if n > 3 {
                v_loop_filter(self.plane(cur, n), dest, self.uvls, 8, self.pq);
            } else {
                v_loop_filter(
                    cur.y,
                    (dest + (((n & 2) * 4) * self.ls)) + ((n & 1) * 8),
                    self.ls,
                    16,
                    self.pq,
                );
            }
        }
    }
    #[inline(always)]
    unsafe fn p_loop_filter(&mut self) {
        let x = self.mb_x;
        let y = self.mb_y;
        let s = self.start_mb_y;
        let last_col = x == (self.mbw - 1);
        let last_row = y == (self.end_mb_y - 1);
        if y >= (s + 2) {
            if truth(x) {
                self.p_v(2, 1, if y == (s + 2) { TOP_EDGE } else { 0 });
            }
            if last_col {
                self.p_v(2, 0, if y == (s + 2) { TOP_EDGE } else { 0 });
            }
        }
        if last_row {
            let bottom = if y == s {
                TOP_EDGE | BOTTOM_EDGE
            } else {
                BOTTOM_EDGE
            };
            if truth(x) {
                if y >= (s + 1) {
                    self.p_v(1, 1, if y == (s + 1) { TOP_EDGE } else { 0 });
                }
                self.p_v(0, 1, bottom);
            }
            if last_col {
                if y >= (s + 1) {
                    self.p_v(1, 0, if y == (s + 1) { TOP_EDGE } else { 0 });
                }
                self.p_v(0, 0, bottom);
            }
        }
        let right_flags = if truth(x) {
            RIGHT_EDGE
        } else {
            LEFT_EDGE | RIGHT_EDGE
        };
        for r in (0..=2).rev() {
            if truth(if r == 2 {
                y < (s + 2)
            } else {
                (!last_row) || ((r == 1) && (y < (s + 1)))
            }) {
                continue;
            }
            if x >= 2 {
                self.p_h(r, 2, if x == 2 { LEFT_EDGE } else { 0 });
            }
            if last_col {
                if x >= 1 {
                    self.p_h(r, 1, if x == 1 { LEFT_EDGE } else { 0 });
                }
                self.p_h(r, 0, right_flags);
            }
        }
    }
    #[inline(always)]
    unsafe fn p_v(&mut self, r: i32, c: i32, flags: i32) {
        let cur = self.cur;
        let ls = self.ls;
        let uvls = self.uvls;
        let mbs = self.mbs;
        let b8 = self.b8;
        let pq = self.pq;
        let m = (((2 * mbs) + self.mb_x) - (r * mbs)) - c;
        let cbp = self.cbp_row;
        let is_intra = self.is_intra_row;
        let motion = self.motion;
        let luma_mv = self.luma_mv;
        let dl = (self.dest0 - ((16 * r) * ls)) - (16 * c);
        let dc = (self.dest1 - ((8 * r) * uvls)) - (8 * c);
        for n in 0..6 {
            let chroma = n > 3;
            let lsz = if chroma { uvls } else { ls };
            let p = self.plane(cur, n);
            let top_cbp = ((cbp.at(m)) as u32 >> (n * 4)) as i32;
            let dst = if chroma {
                dc
            } else {
                (dl + (((n & 2) * 4) * ls)) + ((n & 1) * 8)
            };
            if (!truth(flags & BOTTOM_EDGE)) || (n < 2) {
                let top_intra = is_intra.at(m) & (1 << n);
                let bottom_intra: i32;
                let bottom_cbp: i32;
                if chroma {
                    bottom_intra = is_intra.at(m + mbs) & (1 << n);
                    bottom_cbp = ((cbp.at(m + mbs)) as u32 >> (n * 4)) as i32;
                } else {
                    if n < 2 {
                        bottom_intra = is_intra.at(m) & (1 << (n + 2));
                        bottom_cbp = ((cbp.at(m)) as u32 >> ((n + 2) * 4)) as i32;
                    } else {
                        bottom_intra = is_intra.at(m + mbs) & (1 << (n - 2));
                        bottom_cbp = ((cbp.at(m + mbs)) as u32 >> ((n - 2) * 4)) as i32;
                    }
                }
                let differ: bool;
                if chroma {
                    differ = (luma_mv.at(m * 2) != luma_mv.at((m + mbs) * 2))
                        || (luma_mv.at((m * 2) + 1) != luma_mv.at(((m + mbs) * 2) + 1));
                } else {
                    let k = ((4 + self.bi.at(n)) - ((2 * r) * b8)) - (2 * c);
                    differ = (motion.at(k * 2) != motion.at((k + b8) * 2))
                        || (motion.at((k * 2) + 1) != motion.at(((k + b8) * 2) + 1));
                }
                if (truth(top_intra) || truth(bottom_intra)) || differ {
                    v_loop_filter(p, dst + (8 * lsz), lsz, 8, pq);
                } else {
                    let idx = (top_cbp | (((bottom_cbp) as u32 >> (2)) as i32)) & 3;
                    if truth(idx & 1) {
                        v_loop_filter(p, (dst + (8 * lsz)) + 4, lsz, 4, pq);
                    }
                    if truth(idx & 2) {
                        v_loop_filter(p, dst + (8 * lsz), lsz, 4, pq);
                    }
                }
            }
            let tt = (self.ttblk_row.at(m) >> (n * 4)) & 15;
            if (tt == TT_4X4) || (tt == TT_8X4) {
                if truth(top_cbp & 5) {
                    v_loop_filter(p, (dst + (4 * lsz)) + 4, lsz, 4, pq);
                }
                if truth(top_cbp & 10) {
                    v_loop_filter(p, dst + (4 * lsz), lsz, 4, pq);
                }
            }
        }
    }
    #[inline(always)]
    unsafe fn p_h(&mut self, r: i32, c: i32, flags: i32) {
        let cur = self.cur;
        let ls = self.ls;
        let uvls = self.uvls;
        let mbs = self.mbs;
        let b8 = self.b8;
        let pq = self.pq;
        let m = (((2 * mbs) + self.mb_x) - (r * mbs)) - c;
        let cbp = self.cbp_row;
        let is_intra = self.is_intra_row;
        let motion = self.motion;
        let luma_mv = self.luma_mv;
        let dl = (self.dest0 - ((16 * r) * ls)) - (16 * c);
        let dc = (self.dest1 - ((8 * r) * uvls)) - (8 * c);
        for n in 0..6 {
            let chroma = n > 3;
            let lsz = if chroma { uvls } else { ls };
            let p = self.plane(cur, n);
            let left_cbp = ((cbp.at(m)) as u32 >> (n * 4)) as i32;
            let dst = if chroma {
                dc
            } else {
                (dl + (((n & 2) * 4) * ls)) + ((n & 1) * 8)
            };
            if (!truth(flags & RIGHT_EDGE)) || (!truth(n & 5)) {
                let left_intra = is_intra.at(m) & (1 << n);
                let right_intra: i32;
                let right_cbp: i32;
                if chroma {
                    right_intra = is_intra.at(m + 1) & (1 << n);
                    right_cbp = ((cbp.at(m + 1)) as u32 >> (n * 4)) as i32;
                } else {
                    if truth(n & 1) {
                        right_intra = is_intra.at(m + 1) & (1 << (n - 1));
                        right_cbp = ((cbp.at(m + 1)) as u32 >> ((n - 1) * 4)) as i32;
                    } else {
                        right_intra = is_intra.at(m) & (1 << (n + 1));
                        right_cbp = ((cbp.at(m)) as u32 >> ((n + 1) * 4)) as i32;
                    }
                }
                let differ: bool;
                if chroma {
                    differ = (luma_mv.at(m * 2) != luma_mv.at((m + 1) * 2))
                        || (luma_mv.at((m * 2) + 1) != luma_mv.at(((m + 1) * 2) + 1));
                } else {
                    let k = ((4 + self.bi.at(n)) - ((2 * r) * b8)) - (2 * c);
                    differ = (motion.at(k * 2) != motion.at((k + 1) * 2))
                        || (motion.at((k * 2) + 1) != motion.at(((k + 1) * 2) + 1));
                }
                if (truth(left_intra) || truth(right_intra)) || differ {
                    h_loop_filter(p, dst + 8, lsz, 8, pq);
                } else {
                    let idx = (left_cbp | (((right_cbp) as u32 >> (1)) as i32)) & 5;
                    if truth(idx & 1) {
                        h_loop_filter(p, (dst + (4 * lsz)) + 8, lsz, 4, pq);
                    }
                    if truth(idx & 4) {
                        h_loop_filter(p, dst + 8, lsz, 4, pq);
                    }
                }
            }
            let tt = (self.ttblk_row.at(m) >> (n * 4)) & 15;
            if (tt == TT_4X4) || (tt == TT_4X8) {
                if truth(left_cbp & 3) {
                    h_loop_filter(p, (dst + (4 * lsz)) + 4, lsz, 4, pq);
                }
                if truth(left_cbp & 12) {
                    h_loop_filter(p, dst + 4, lsz, 4, pq);
                }
            }
        }
    }
    #[inline(always)]
    unsafe fn p_coefficients(
        &mut self,
        b: i32,
        cs: i32,
        quant: i32,
        scale: i32,
        pquantizer: i32,
        scan: &[i32],
        off: i32,
        limit: i32,
        mut last: i32,
    ) -> i32 {
        let block = self.blocks;
        let mut i = 0;
        while !truth(last) {
            let ret = self.ac_coeff(cs);
            if ret < 0 {
                return ret;
            }
            last = self.ac_last;
            i = i + self.ac_run;
            if i > limit {
                break;
            }
            let idx = (b + scan.at({
                let previous = i;
                i = i + 1;
                previous
            })) + off;
            block.set(idx, self.ac_value * scale);
            if !truth(pquantizer) {
                block.set(
                    idx,
                    block.at(idx) + (if block.at(idx) < 0 { -quant } else { quant }),
                );
            }
        }
        return i;
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_decode_blocks(
    state: *const i32,
    data: *const u8,
    index: i32,
    size: i32,
) -> i32 {
    let mut decoder = Decoder::new(state, data, index, size);
    decoder.decode_blocks();
    decoder.gb.index
}
