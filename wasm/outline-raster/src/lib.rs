#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const ONE_PIXEL: i32 = 256;
const TAG_ON: u8 = 1;
const TAG_CUBIC: u8 = 2;
/// `FT_Err_Invalid_Outline`.
const INVALID_OUTLINE: i32 = 0x14;

/// The arithmetic of FreeType 2.4.8's `ftgrays.c` (PIXEL_BITS 8, nonzero fill, 32-bit
/// `TPos`/`TArea`, wrapping like the 32-bit C build). Cells accumulate in dense per-row
/// cover/area arrays; the sweep visits the same cells in the same order as FreeType's banded
/// cell lists. `src/text/outline-font/raster.ts` is the same algorithm in JavaScript.
struct Raster {
    cover: *mut i32,
    area: *mut i32,
    stride: i32,
    min_ex: i32,
    max_ex: i32,
    min_ey: i32,
    max_ey: i32,
    count_ex: i32,
    count_ey: i32,
    ex: i32,
    ey: i32,
    cell_area: i32,
    cell_cover: i32,
    invalid: bool,
    x: i32,
    y: i32,
    last_ey: i32,
    bez: [i32; 2 * (32 * 3 + 1)],
    levels: [i32; 32],
}

#[inline(always)]
fn div(a: i32, b: i32) -> i32 {
    a.wrapping_div(b)
}

impl Raster {
    #[inline(always)]
    unsafe fn record_cell(&mut self) {
        if !self.invalid && (self.cell_area | self.cell_cover) != 0 {
            let ex = if self.ex > self.count_ex {
                self.count_ex
            } else {
                self.ex
            };
            let i = (self.ey * self.stride + ex + 1) as usize;
            *self.area.add(i) = (*self.area.add(i)).wrapping_add(self.cell_area);
            *self.cover.add(i) = (*self.cover.add(i)).wrapping_add(self.cell_cover);
        }
    }

    #[inline(always)]
    unsafe fn set_cell(&mut self, mut ex: i32, mut ey: i32) {
        ey = ey.wrapping_sub(self.min_ey);
        if ex > self.max_ex {
            ex = self.max_ex;
        }
        ex = ex.wrapping_sub(self.min_ex);
        if ex < 0 {
            ex = -1;
        }
        if ex != self.ex || ey != self.ey {
            if !self.invalid {
                self.record_cell();
            }
            self.cell_area = 0;
            self.cell_cover = 0;
        }
        self.ex = ex;
        self.ey = ey;
        self.invalid = ey as u32 >= self.count_ey as u32 || ex >= self.count_ex;
    }

    unsafe fn move_to(&mut self, x: i32, y: i32) {
        self.record_cell();
        let x = x.wrapping_shl(2);
        let y = y.wrapping_shl(2);
        let mut ex = x >> 8;
        let ey = y >> 8;
        if ex > self.max_ex {
            ex = self.max_ex;
        }
        if ex < self.min_ex {
            ex = self.min_ex - 1;
        }
        self.cell_area = 0;
        self.cell_cover = 0;
        self.ex = ex.wrapping_sub(self.min_ex);
        self.ey = ey.wrapping_sub(self.min_ey);
        self.last_ey = ey.wrapping_shl(8);
        self.invalid = false;
        self.set_cell(ex, ey);
        self.x = x;
        self.y = y;
    }

    #[inline(always)]
    fn add(&mut self, area: i32, cover: i32) {
        self.cell_area = self.cell_area.wrapping_add(area);
        self.cell_cover = self.cell_cover.wrapping_add(cover);
    }

    unsafe fn render_scanline(&mut self, ey: i32, x1: i32, mut y1: i32, x2: i32, y2: i32) {
        let mut dx = x2.wrapping_sub(x1);
        let mut ex1 = x1 >> 8;
        let ex2 = x2 >> 8;
        let fx1 = x1 - (ex1 << 8);
        let fx2 = x2 - (ex2 << 8);
        if y1 == y2 {
            self.set_cell(ex2, ey);
            return;
        }
        if ex1 == ex2 {
            let delta = y2 - y1;
            self.add((fx1 + fx2).wrapping_mul(delta), delta);
            return;
        }
        let mut p = (ONE_PIXEL - fx1).wrapping_mul(y2 - y1);
        let mut first = ONE_PIXEL;
        let mut incr = 1;
        if dx < 0 {
            p = fx1.wrapping_mul(y2 - y1);
            first = 0;
            incr = -1;
            dx = dx.wrapping_neg();
        }
        let mut delta = div(p, dx);
        let mut m = p.wrapping_rem(dx);
        if m < 0 {
            delta -= 1;
            m += dx;
        }
        self.add((fx1 + first).wrapping_mul(delta), delta);
        ex1 = ex1.wrapping_add(incr);
        self.set_cell(ex1, ey);
        y1 = y1.wrapping_add(delta);
        if ex1 != ex2 {
            p = ONE_PIXEL.wrapping_mul(y2.wrapping_sub(y1).wrapping_add(delta));
            let mut lift = div(p, dx);
            let mut rem = p.wrapping_rem(dx);
            if rem < 0 {
                lift -= 1;
                rem += dx;
            }
            m -= dx;
            while ex1 != ex2 {
                delta = lift;
                m += rem;
                if m >= 0 {
                    m -= dx;
                    delta += 1;
                }
                self.add(ONE_PIXEL.wrapping_mul(delta), delta);
                y1 = y1.wrapping_add(delta);
                ex1 = ex1.wrapping_add(incr);
                self.set_cell(ex1, ey);
            }
        }
        delta = y2.wrapping_sub(y1);
        self.add((fx2 + ONE_PIXEL - first).wrapping_mul(delta), delta);
    }

    /// `gray_render_line` to a point in 24.8 subpixels.
    unsafe fn render_line(&mut self, to_x: i32, to_y: i32) {
        let mut ey1 = self.last_ey >> 8;
        let ey2 = to_y >> 8;
        let fy1 = self.y.wrapping_sub(self.last_ey);
        let fy2 = to_y - (ey2 << 8);
        let dx = to_x.wrapping_sub(self.x);
        let mut dy = to_y.wrapping_sub(self.y);
        let (min, max) = if ey1 < ey2 { (ey1, ey2) } else { (ey2, ey1) };
        if !(min >= self.max_ey || max < self.min_ey) {
            if ey1 == ey2 {
                self.render_scanline(ey1, self.x, fy1, to_x, fy2);
            } else if dx == 0 {
                let ex = self.x >> 8;
                let two_fx = (self.x - (ex << 8)) << 1;
                let (first, incr) = if dy < 0 { (0, -1) } else { (ONE_PIXEL, 1) };
                let mut delta = first - fy1;
                self.add(two_fx.wrapping_mul(delta), delta);
                ey1 = ey1.wrapping_add(incr);
                self.set_cell(ex, ey1);
                delta = first + first - ONE_PIXEL;
                let area = two_fx.wrapping_mul(delta);
                while ey1 != ey2 {
                    self.add(area, delta);
                    ey1 = ey1.wrapping_add(incr);
                    self.set_cell(ex, ey1);
                }
                delta = fy2 - ONE_PIXEL + first;
                self.add(two_fx.wrapping_mul(delta), delta);
            } else {
                let mut p = (ONE_PIXEL - fy1).wrapping_mul(dx);
                let mut first = ONE_PIXEL;
                let mut incr = 1;
                if dy < 0 {
                    p = fy1.wrapping_mul(dx);
                    first = 0;
                    incr = -1;
                    dy = dy.wrapping_neg();
                }
                let mut delta = div(p, dy);
                let mut m = p.wrapping_rem(dy);
                if m < 0 {
                    delta -= 1;
                    m += dy;
                }
                let mut x = self.x.wrapping_add(delta);
                self.render_scanline(ey1, self.x, fy1, x, first);
                ey1 = ey1.wrapping_add(incr);
                self.set_cell(x >> 8, ey1);
                if ey1 != ey2 {
                    p = ONE_PIXEL.wrapping_mul(dx);
                    let mut lift = div(p, dy);
                    let mut rem = p.wrapping_rem(dy);
                    if rem < 0 {
                        lift -= 1;
                        rem += dy;
                    }
                    m -= dy;
                    while ey1 != ey2 {
                        delta = lift;
                        m += rem;
                        if m >= 0 {
                            m -= dy;
                            delta += 1;
                        }
                        let x2 = x.wrapping_add(delta);
                        self.render_scanline(ey1, x, ONE_PIXEL - first, x2, first);
                        x = x2;
                        ey1 = ey1.wrapping_add(incr);
                        self.set_cell(x >> 8, ey1);
                    }
                }
                self.render_scanline(ey1, x, ONE_PIXEL - first, to_x, fy2);
            }
        }
        self.x = to_x;
        self.y = to_y;
        self.last_ey = ey2.wrapping_shl(8);
    }

    /// `gray_render_conic` (26.6 control and end point).
    unsafe fn render_conic(&mut self, cx: i32, cy: i32, tx: i32, ty: i32) {
        self.bez[0] = tx.wrapping_shl(2);
        self.bez[1] = ty.wrapping_shl(2);
        self.bez[2] = cx.wrapping_shl(2);
        self.bez[3] = cy.wrapping_shl(2);
        self.bez[4] = self.x;
        self.bez[5] = self.y;
        let arc = &mut self.bez;
        let mut dx = arc[4]
            .wrapping_add(arc[0])
            .wrapping_sub(arc[2].wrapping_mul(2))
            .wrapping_abs();
        let dy = arc[5]
            .wrapping_add(arc[1])
            .wrapping_sub(arc[3].wrapping_mul(2))
            .wrapping_abs();
        if dx < dy {
            dx = dy;
        }
        let mut draw = dx < ONE_PIXEL / 4;
        if !draw {
            let mut min = arc[1];
            let mut max = min;
            for &y in [arc[3], arc[5]].iter() {
                if y < min {
                    min = y;
                }
                if y > max {
                    max = y;
                }
            }
            draw = min >> 8 >= self.max_ey || max >> 8 < self.min_ey;
        }
        if draw {
            let (x, y) = (arc[0], arc[1]);
            self.render_line(x, y);
            return;
        }
        let mut level = 0;
        loop {
            dx >>= 2;
            level += 1;
            if dx <= ONE_PIXEL / 4 {
                break;
            }
        }
        self.levels[0] = level;
        let mut a: usize = 0;
        let mut top: isize = 0;
        loop {
            level = self.levels[top as usize];
            if level > 0 {
                let arc = &mut self.bez;
                let o = a * 2;
                arc[o + 8] = arc[o + 4];
                let mut q = arc[o + 2];
                let mut p = div(arc[o + 4].wrapping_add(q), 2);
                arc[o + 6] = p;
                q = div(arc[o].wrapping_add(q), 2);
                arc[o + 2] = q;
                arc[o + 4] = div(p.wrapping_add(q), 2);
                arc[o + 9] = arc[o + 5];
                q = arc[o + 3];
                p = div(arc[o + 5].wrapping_add(q), 2);
                arc[o + 7] = p;
                q = div(arc[o + 1].wrapping_add(q), 2);
                arc[o + 3] = q;
                arc[o + 5] = div(p.wrapping_add(q), 2);
                a += 2;
                top += 1;
                self.levels[top as usize] = level - 1;
                self.levels[top as usize - 1] = level - 1;
                continue;
            }
            let (x, y) = (self.bez[a * 2], self.bez[a * 2 + 1]);
            self.render_line(x, y);
            top -= 1;
            a = a.wrapping_sub(2);
            if top < 0 {
                break;
            }
        }
    }

    /// `gray_render_cubic` (26.6 control points and end point).
    unsafe fn render_cubic(&mut self, c1x: i32, c1y: i32, c2x: i32, c2y: i32, tx: i32, ty: i32) {
        {
            let arc = &mut self.bez;
            arc[0] = tx.wrapping_shl(2);
            arc[1] = ty.wrapping_shl(2);
            arc[2] = c2x.wrapping_shl(2);
            arc[3] = c2y.wrapping_shl(2);
            arc[4] = c1x.wrapping_shl(2);
            arc[5] = c1y.wrapping_shl(2);
            arc[6] = self.x;
            arc[7] = self.y;
        }
        let arc = &self.bez;
        let mut min = arc[1];
        let mut max = min;
        for &y in [arc[3], arc[5], arc[7]].iter() {
            if y < min {
                min = y;
            }
            if y > max {
                max = y;
            }
        }
        if min >> 8 >= self.max_ey || max >> 8 < self.min_ey {
            let (x, y) = (arc[0], arc[1]);
            self.render_line(x, y);
            return;
        }
        let mut o: usize = 0;
        loop {
            let arc = &mut self.bez;
            let (x0, y0, x1, y1) = (arc[o], arc[o + 1], arc[o + 2], arc[o + 3]);
            let (x2, y2, x3, y3) = (arc[o + 4], arc[o + 5], arc[o + 6], arc[o + 7]);
            let dx = x3.wrapping_sub(x0);
            let dy = y3.wrapping_sub(y0);
            let ax = dx.wrapping_abs();
            let ay = dy.wrapping_abs();
            let l = (if ax > ay {
                236i32.wrapping_mul(ax).wrapping_add(97i32.wrapping_mul(ay))
            } else {
                97i32.wrapping_mul(ax).wrapping_add(236i32.wrapping_mul(ay))
            }) >> 8;
            let mut split = l > 32767;
            if !split {
                let s_limit = l.wrapping_mul(ONE_PIXEL / 6);
                let (dx1, dy1) = (x1.wrapping_sub(x0), y1.wrapping_sub(y0));
                let (dx2, dy2) = (x2.wrapping_sub(x0), y2.wrapping_sub(y0));
                let cross = |ux: i32, uy: i32| {
                    dy.wrapping_mul(ux)
                        .wrapping_sub(dx.wrapping_mul(uy))
                        .wrapping_abs()
                };
                let dot = |ux: i32, uy: i32| dy.wrapping_mul(uy).wrapping_add(dx.wrapping_mul(ux));
                split = cross(dx1, dy1) > s_limit
                    || cross(dx2, dy2) > s_limit
                    || dot(dx1, dy1) < 0
                    || dot(dx2, dy2) < 0
                    || dot(x3.wrapping_sub(x1), y3.wrapping_sub(y1)) < 0
                    || dot(x3.wrapping_sub(x2), y3.wrapping_sub(y2)) < 0;
            }
            if split {
                // gray_split_cubic on arc[o..o + 14]
                arc[o + 12] = x3;
                let mut a = div(x0.wrapping_add(x1), 2);
                let mut b = div(x3.wrapping_add(x2), 2);
                let c = div(x1.wrapping_add(x2), 2);
                arc[o + 2] = a;
                arc[o + 10] = b;
                a = div(a.wrapping_add(c), 2);
                b = div(b.wrapping_add(c), 2);
                arc[o + 4] = a;
                arc[o + 8] = b;
                arc[o + 6] = div(a.wrapping_add(b), 2);
                arc[o + 13] = y3;
                let mut a = div(y0.wrapping_add(y1), 2);
                let mut b = div(y3.wrapping_add(y2), 2);
                let c = div(y1.wrapping_add(y2), 2);
                arc[o + 3] = a;
                arc[o + 11] = b;
                a = div(a.wrapping_add(c), 2);
                b = div(b.wrapping_add(c), 2);
                arc[o + 5] = a;
                arc[o + 9] = b;
                arc[o + 7] = div(a.wrapping_add(b), 2);
                o += 6;
                continue;
            }
            self.render_line(x0, y0);
            if o == 0 {
                return;
            }
            o -= 6;
        }
    }

    /// `FT_Outline_Decompose` with shift 0 and delta 0.
    unsafe fn decompose(
        &mut self,
        v: *const i32,
        tags: *const u8,
        contours: *const i16,
        n_contours: i32,
    ) -> i32 {
        let px = |i: i32| *v.add(i as usize * 2);
        let py = |i: i32| *v.add(i as usize * 2 + 1);
        let tag = |i: i32| *tags.add(i as usize) & 3;
        let mut first: i32 = 0;
        for n in 0..n_contours as usize {
            let last = *contours.add(n) as i32;
            if last < 0 {
                return INVALID_OUTLINE;
            }
            let mut limit = last;
            let mut start_x = px(first);
            let mut start_y = py(first);
            let (last_x, last_y) = (px(last), py(last));
            let mut point = first;
            let t = tag(first);
            if t == TAG_CUBIC {
                return INVALID_OUTLINE;
            }
            if t == 0 {
                if tag(last) == TAG_ON {
                    start_x = last_x;
                    start_y = last_y;
                    limit -= 1;
                } else {
                    start_x = div(start_x.wrapping_add(last_x), 2);
                    start_y = div(start_y.wrapping_add(last_y), 2);
                }
                point -= 1;
            }
            self.move_to(start_x, start_y);
            let mut closed = false;
            'contour: while point < limit {
                point += 1;
                let t = tag(point);
                if t == TAG_ON {
                    self.render_line(px(point).wrapping_shl(2), py(point).wrapping_shl(2));
                    continue;
                }
                if t == 0 {
                    let mut control_x = px(point);
                    let mut control_y = py(point);
                    loop {
                        if point < limit {
                            point += 1;
                            let t = tag(point);
                            let (x, y) = (px(point), py(point));
                            if t == TAG_ON {
                                self.render_conic(control_x, control_y, x, y);
                                continue 'contour;
                            }
                            if t != 0 {
                                return INVALID_OUTLINE;
                            }
                            self.render_conic(
                                control_x,
                                control_y,
                                div(control_x.wrapping_add(x), 2),
                                div(control_y.wrapping_add(y), 2),
                            );
                            control_x = x;
                            control_y = y;
                            continue;
                        }
                        self.render_conic(control_x, control_y, start_x, start_y);
                        closed = true;
                        break 'contour;
                    }
                }
                // Cubic: two control points, then an on point or the contour start.
                if point + 1 > limit || tag(point + 1) != TAG_CUBIC {
                    return INVALID_OUTLINE;
                }
                point += 2;
                let (c1x, c1y, c2x, c2y) =
                    (px(point - 2), py(point - 2), px(point - 1), py(point - 1));
                if point <= limit {
                    self.render_cubic(c1x, c1y, c2x, c2y, px(point), py(point));
                    continue;
                }
                self.render_cubic(c1x, c1y, c2x, c2y, start_x, start_y);
                closed = true;
                break;
            }
            if !closed {
                self.render_line(start_x.wrapping_shl(2), start_y.wrapping_shl(2));
            }
            first = last + 1;
        }
        0
    }

    /// `gray_sweep` + `gray_hline` + `gray_render_span` for the nonzero rule. Each row's cover
    /// prefix sum runs four cells per step.
    unsafe fn sweep(&self, width: i32, height: i32, out: *mut u8) {
        let count_ex = self.count_ex as usize;
        let stride = self.stride as usize;
        for y in 0..self.count_ey {
            let row = out.add(((height - 1 - (y + self.min_ey)) * width + self.min_ex) as usize);
            let base = y as usize * stride;
            let cover = self.cover.add(base + 1);
            let area = self.area.add(base + 1);
            // The clipped cell left of the bitmap.
            let mut c = *self.cover.add(base);
            let mut x = 0usize;
            let mut carry = i32x4_splat(c);
            let zero = i32x4_splat(0);
            while x + 4 <= count_ex {
                let mut v = v128_load(cover.add(x) as *const v128);
                v = i32x4_add(v, i32x4_shuffle::<4, 0, 1, 2>(v, zero));
                v = i32x4_add(v, i32x4_shuffle::<4, 5, 0, 1>(v, zero));
                v = i32x4_add(v, carry);
                carry = i32x4_shuffle::<3, 3, 3, 3>(v, v);
                let a = i32x4_sub(i32x4_shl(v, 9), v128_load(area.add(x) as *const v128));
                let coverage = i32x4_abs(i32x4_shr(a, 9));
                let halves = i16x8_narrow_i32x4(coverage, coverage);
                let bytes = u8x16_narrow_i16x8(halves, halves);
                v128_store32_lane::<0>(bytes, row.add(x) as *mut u32);
                x += 4;
            }
            if x > 0 {
                c = i32x4_extract_lane::<0>(carry);
            }
            while x < count_ex {
                c = c.wrapping_add(*cover.add(x));
                let a = c.wrapping_shl(9).wrapping_sub(*area.add(x));
                let coverage = (a >> 9).wrapping_abs();
                *row.add(x) = if coverage >= 256 { 255 } else { coverage as u8 };
                x += 1;
            }
        }
    }
}

/// Renders an outline (26.6 points already translated into the bitmap, `FT_Outline` tags and
/// contour ends) into `out`, `width` × `height` top-down bytes, like `gray_raster_render` with
/// the bitmap as clip box. `cells` holds `2 * (width + 1) * height` words of scratch. Returns
/// 0 or a FreeType error code; `out` is fully written either way.
#[no_mangle]
pub unsafe extern "C" fn outline_render(
    points: *const i32,
    tags: *const u8,
    contours: *const i16,
    n_points: i32,
    n_contours: i32,
    width: i32,
    height: i32,
    out: *mut u8,
    cells: *mut i32,
) -> i32 {
    core::ptr::write_bytes(out, 0, (width * height) as usize);
    if n_points == 0 || n_contours <= 0 {
        return 0;
    }
    if n_points != *contours.add(n_contours as usize - 1) as i32 + 1 {
        return INVALID_OUTLINE;
    }
    if width == 0 || height == 0 {
        return 0;
    }
    // gray_compute_cbox + clip to the target.
    let (mut x_min, mut y_min) = (*points, *points.add(1));
    let (mut x_max, mut y_max) = (x_min, y_min);
    for i in 1..n_points as usize {
        let x = *points.add(i * 2);
        let y = *points.add(i * 2 + 1);
        x_min = x_min.min(x);
        x_max = x_max.max(x);
        y_min = y_min.min(y);
        y_max = y_max.max(y);
    }
    let mut min_ex = x_min >> 6;
    let mut min_ey = y_min >> 6;
    let mut max_ex = x_max.wrapping_add(63) >> 6;
    let mut max_ey = y_max.wrapping_add(63) >> 6;
    if max_ex <= 0 || min_ex >= width || max_ey <= 0 || min_ey >= height {
        return 0;
    }
    min_ex = min_ex.max(0);
    min_ey = min_ey.max(0);
    max_ex = max_ex.min(width);
    max_ey = max_ey.min(height);
    let count_ex = max_ex - min_ex;
    let count_ey = max_ey - min_ey;
    let stride = count_ex + 1;
    let count = (stride * count_ey) as usize;
    let cover = cells;
    let area = cells.add(count);
    core::ptr::write_bytes(cells, 0, count * 2);
    let mut raster = Raster {
        cover,
        area,
        stride,
        min_ex,
        max_ex,
        min_ey,
        max_ey,
        count_ex,
        count_ey,
        ex: 0,
        ey: 0,
        cell_area: 0,
        cell_cover: 0,
        invalid: true,
        x: 0,
        y: 0,
        last_ey: 0,
        bez: [0; 2 * (32 * 3 + 1)],
        levels: [0; 32],
    };
    let error = raster.decompose(points, tags, contours, n_contours);
    if error != 0 {
        core::ptr::write_bytes(out, 0, (width * height) as usize);
        return error;
    }
    raster.record_cell();
    raster.sweep(width, height, out);
    0
}

/// `FT_Bitmap_Embolden` on an 8-bit bitmap with positive pitch. Each pixel becomes the
/// saturated sum of itself and the `xstr` pixels to its left, and each row is OR-ed into the
/// `ystr` rows above it. `out` receives `(width + xstr) × (rows + ystr)` bytes; `scratch`
/// holds `width + 2 * xstr + 16` bytes.
#[no_mangle]
pub unsafe extern "C" fn outline_embolden(
    src: *const u8,
    width: i32,
    rows: i32,
    xstr: i32,
    ystr: i32,
    out: *mut u8,
    scratch: *mut u8,
) {
    let (width, rows, xstr, ystr) = (width as usize, rows as usize, xstr as usize, ystr as usize);
    let pitch = width + xstr;
    let total = rows + ystr;
    core::ptr::write_bytes(out, 0, pitch * ystr);
    // The source row sits after `xstr` zeros; everything past it stays zero.
    core::ptr::write_bytes(scratch, 0, width + 2 * xstr + 16);
    let padded = scratch.add(xstr);
    for y in 0..rows {
        core::ptr::copy_nonoverlapping(src.add(y * width), padded, width);
        let row = out.add((y + ystr) * pitch);
        let mut x = 0usize;
        while x + 16 <= pitch {
            let mut sum = v128_load(padded.add(x) as *const v128);
            for i in 1..=xstr {
                sum = u8x16_add_sat(sum, v128_load(padded.add(x).sub(i) as *const v128));
            }
            v128_store(row.add(x) as *mut v128, sum);
            x += 16;
        }
        while x < pitch {
            let mut sum = *padded.add(x) as u32;
            for i in 1..=xstr {
                sum += *padded.add(x).sub(i) as u32;
            }
            *row.add(x) = if sum > 255 { 255 } else { sum as u8 };
            x += 1;
        }
    }
    // Ascending rows: row r becomes the OR of rows r..=r + ystr, which are still unmerged.
    for r in 0..total {
        let row = out.add(r * pitch);
        for k in 1..=ystr {
            if r + k >= total {
                break;
            }
            let below = out.add((r + k) * pitch);
            let mut x = 0usize;
            while x + 16 <= pitch {
                let value = v128_or(
                    v128_load(row.add(x) as *const v128),
                    v128_load(below.add(x) as *const v128),
                );
                v128_store(row.add(x) as *mut v128, value);
                x += 16;
            }
            while x < pitch {
                *row.add(x) |= *below.add(x);
                x += 1;
            }
        }
    }
}
