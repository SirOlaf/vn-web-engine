import {tokenLayouts, tipsLayouts} from './dom-text-data.js';
import type {NoahState} from './noah-state.js';
import {romByte, romWord} from './text-rom.js';
import {checkRange} from '../../../../../core/binary.js';
export interface TextHost {
  byte(address: number): number;
  message(slot: number, id: number): number;
  expression(address: number): {value: number; next: number};
}
const GLYPHS = 0x80d860,
  METRICS = 0x802700,
  STYLE = 0x719a10,
  FONT = 0x7fbfa0,
  BREAK = 0x80c520,
  XY = 0x732dc0;
const u = (n: number) => n >>> 0,
  mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
const div = (a: number, b: number) => {
  if (!b) throw new Error('Native text division by zero');
  return Math.floor((a >>> 0) / (b >>> 0)) >>> 0;
};
/** Shared native text pipeline: audited parse modes 0, 1, 2, 3, 4 and 5,
 * font-dependent break rules, wrapping and layout.
 * Glyph IDs remain glyph IDs. The compositor and Unicode presentation are separate. */
export class TipsText {
  protected fontBase = 0x7fbe40;
  constructor(
    readonly s: NoahState,
    readonly host: TextHost,
  ) {}
  protected get(a: number) {
    return this.s.get(a) >>> 0;
  }
  protected put(a: number, v: number) {
    this.s.put(a, v);
  }
  protected short(a: number) {
    return this.s.view(a, 2).getUint16(0, true);
  }
  protected signed(a: number) {
    return this.s.view(a, 2).getInt16(0, true);
  }
  protected glyph(i: number) {
    return this.short(GLYPHS + i * 2);
  }
  protected metric(i: number, w: number) {
    return this.get(METRICS + i * 16 + w * 4);
  }
  protected setMetric(i: number, w: number, v: number) {
    this.put(METRICS + i * 16 + w * 4, v);
  }
  protected rule(i: number) {
    return this.s.bytes(BREAK + i, 1)[0]!;
  }
  protected setRule(i: number, v: number) {
    this.s.put(BREAK + i, v, 1);
  }
  protected be(a: number) {
    return this.host.byte(a) * 256 + this.host.byte(a + 1);
  }
  parse(address: number, mode: 0 | 1 | 2 | 3 | 4 | 5 = 0, fontIndex = 4, initialColor = 0): number {
    this.fontBase = 0x7fbd80 + fontIndex * 48;
    let firstRuby = 0,
      afterBreak = false;
    const s = this.s;
    let count = 0,
      font = 0,
      hidden = 0,
      ruby = 0,
      color = initialColor,
      size = this.short(this.fontBase + 0x1c) * 1000;
    this.put(0x768718, mode === 2 || mode === 3 || mode === 5 ? 1 : 0);
    if (mode === 0) {
      this.put(0x6610cc, 0);
      this.put(0x80c3f0, 0);
    }
    this.put(0x6610c8, 0);
    this.put(0x737988, 0);
    s.put(0x80cfe8, 0, 8);
    if (s.flags[0xbe]! & 1) {
      this.put(0x660ff8, this.get(0x80f344));
      if (
        this.short(0x7fbd94 + mode * 48) <
        u(this.short(this.fontBase + 0x1c) - this.signed(this.fontBase + 0x4) + this.get(0x732a9c))
      ) {
        this.put(0x802708, 0);
        this.put(0x737988, 1);
        s.put(GLYPHS, 0x8000, 2);
        this.put(0x66b350, 0);
        count = 1;
      }
    }
    this.put(0x7fbf64, 0);
    this.put(0x799b18, 0);
    s.zero(0x80f350, 160);
    const emit = (glyph: number, width: number, height: number, advance: number, h: number) => {
      checkRange(2400, count, 1);
      s.put(GLYPHS + count * 2, glyph, 2);
      this.setMetric(count, 0, width);
      this.setMetric(count, 1, height);
      this.setMetric(count, 2, advance);
      this.setMetric(count, 3, h);
      s.put(STYLE + count, color, 1);
      s.put(FONT + count, font, 1);
      this.put(0x66b350 + count * 4, 0);
      this.put(0x737988, ++count);
    };
    const width = (id: number, limit = 351) =>
      id < limit ? romByte((font ? 0x1da120 : 0x1da350) + id) : id > 0x27ff ? 17 : 32;
    if (mode === 3) emit(0xe0, 12, 32, div(mul(12, size), 32000), div(size, 1000));
    for (let budget = 0; budget < 100000; budget++) {
      const b = this.host.byte(address);
      if (b === 255) {
        if (mode === 3) {
          const previousFont = font;
          font = 0;
          emit(0xe1, 12, 32, div(mul(12, size), 32000), div(size, 1000));
          font = previousFont;
        }
        s.put(GLYPHS + count * 2, 0x8000, 2);
        return firstRuby;
      }
      if (b >= 128) {
        const id = (b & 127) * 256 + this.host.byte(address + 1);
        address += 2;
        if (hidden) continue;
        const w = width(id);
        emit(id, w, 32, div(mul(w, size), 32000), div(size, 1000));
        let weight = 1;
        for (let a = 0x1d7828; romWord(a) !== 65535; a += 8)
          if (romWord(a) === id) {
            weight = romWord(a + 4);
            break;
          }
        if (!ruby) {
          this.put(0x6610c8, this.get(0x6610c8) + weight);
          this.put(
            0x80f350 + this.get(0x7fbf64) * 4,
            this.get(0x80f350 + this.get(0x7fbf64) * 4) + weight,
          );
        }
        continue;
      }
      checkRange(2400, count, 1);
      this.setMetric(count, 2, 0);
      this.setMetric(count, 3, 0);
      this.put(0x66b350 + count * 4, 0);
      s.put(GLYPHS + count * 2, 0x8000 + b, 2);
      const token = () => this.put(0x737988, ++count);
      switch (b) {
        case 0:
        case 3:
        case 5:
        case 6:
        case 8:
        case 13:
        case 23:
        case 24:
        case 30:
          token();
          address++;
          break;
        case 1: {
          address++;
          hidden = 1;
          s.put(0x80cfe8, address, 8);
          token();
          let index = 65535;
          const total = this.get(0x76871c),
            slot = this.get(0x66d8d8);
          if (total) {
            index = 0;
            for (let i = 0; i < total; i++) {
              let a = address,
                m = this.host.message(slot, this.get(0x799da0 + i * 4));
              while (
                this.host.byte(a) !== 2 &&
                this.host.byte(m) !== 255 &&
                this.host.byte(a) === this.host.byte(m) &&
                this.host.byte(a + 1) === this.host.byte(m + 1)
              ) {
                a += 2;
                m += 2;
              }
              if (this.host.byte(a) === 2 && this.host.byte(m) === 255) {
                index = this.get(0x6e7eb0 + i * 4);
                break;
              }
            }
          }
          checkRange(300, index, 1);
          let name = this.host.message(slot, this.get(0x69e620 + index * 4));
          while (this.host.byte(name) !== 255) {
            const id = (this.host.byte(name) & 127) * 256 + this.host.byte(name + 1),
              w = width(id);
            emit(id, w, 32, div(mul(w, size), 32000), div(size, 1000));
            name += 2;
          }
          this.put(0x660ff8, 1);
          this.put(0x80f344, 1);
          break;
        }
        case 2:
          token();
          address++;
          hidden = 0;
          color = initialColor;
          break;
        case 4: {
          const r = this.host.expression(address + 1);
          address = r.next;
          if (mode === 1 || mode === 3) break;
          color = r.value;
          if (color === 255) color = s.variable(0x21d8 / 4);
          if (color === 254) color = s.variable(0x21dc / 4);
          if (color === 253) color = s.variable(0x21e0 / 4);
          break;
        }
        case 7:
          if (mode === 0) {
            this.setMetric(count, 0, this.host.byte(address + 1));
            this.put(0x6610c8, this.get(0x6610c8) + this.host.byte(address + 1));
            token();
          }
          address += 2;
          break;
        case 9:
          if (!afterBreak) firstRuby = 1;
          token();
          address++;
          break;
        case 10:
          ruby = 1;
          token();
          address++;
          break;
        case 11:
          ruby = 0;
          token();
          address++;
          break;
        case 12:
          if (mode !== 1) size = mul(this.be(address + 1), this.short(this.fontBase + 0x1c));
          address += 3;
          break;
        case 14:
          this.put(0x7fbf64, this.get(0x7fbf64) + 1);
          this.put(0x799b18, 1);
          token();
          address++;
          break;
        case 15:
          this.put(0x768718, 1);
          address++;
          break;
        case 16:
          this.put(0x768718, mode < 2 ? 2 : 0);
          address++;
          break;
        case 49:
          this.put(0x768718, 2);
          address++;
          break;
        case 17:
        case 18:
        case 25:
        case 26: {
          const n = this.be(address + 1);
          if (mode === 0 || b === 25 || b === 26) {
            this.setMetric(count, 0, n);
            if (b === 18) this.setMetric(count, 2, n);
            token();
          }
          address += 3;
          break;
        }
        case 19:
        case 20: {
          const n = s.variable(this.be(address + 1)).toString(10);
          address += 3;
          for (const ch of n) {
            let id = 0;
            const base = 0x1da080; // full-width numeric alphabet is addressed separately below
            if (b === 19) {
              while (romByte(base + id) !== 0 && romByte(base + id) !== ch.charCodeAt(0)) id++;
            } else {
              const alphabet =
                ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz__,.:;?!______()__[]{}__________<>_______-__________________________________________%___/';
              const found = alphabet.indexOf(ch);
              id = found < 0 ? alphabet.length : found;
              id = id ? id + 64 : 0;
            }
            const w = id < 400 ? romByte((b === 19 || !font ? 0x1da350 : 0x1da120) + id) : 32;
            emit(id, w, 32, div(mul(w, size), 32000), div(size, 1000));
            this.put(0x6610c8, this.get(0x6610c8) + 1);
          }
          break;
        }
        case 21: {
          address++;
          if (mode === 0) {
            const n = this.get(0x6610cc);
            this.put(0x6610cc, n + 1);
            s.put(0x80c350 + n * 8, address, 8);
          }
          while (this.host.byte(address) !== 0) {
            const k = this.host.byte(address);
            address += k >= 128 && k & 96 ? ((k & 96) === 32 ? 3 : (k & 96) === 64 ? 4 : 6) : 2;
          }
          address++;
          token();
          break;
        }
        case 22: {
          if (mode === 0) {
            const n = this.get(0x80c3f0);
            this.put(0x80c3f0, n + 1);
            this.put(0x799b20 + n * 4, this.be(address + 1));
          }
          address += 3;
          token();
          break;
        }
        case 27:
          font = this.host.byte(address + 1);
          address += 2;
          break;
        case 31:
          if (mode === 0) {
            s.put(GLYPHS + count * 2, 0x8000, 2);
            token();
          }
          afterBreak = true;
          address++;
          break;
        default:
          throw new Error(
            `Native text parser does not advance on control 0x${b.toString(16)} at 0x${address.toString(16)}`,
          );
      }
    }
    throw new Error('Text parser failed to terminate');
  }
  classify(): void {
    let ruby = false,
      base = false,
      name = false;
    const n = this.get(0x737988),
      word = (x: number) =>
        (x - 1) >>> 0 < 62 || (x - 128) >>> 0 < 62 || [64, 278, 71, 193].includes(x);
    for (let i = 0; i < n; i++) {
      const id = this.glyph(i);
      let rule = 0;
      if (id & 0x8000) {
        switch (id & 255) {
          case 0:
            rule = 7;
            break;
          case 1:
            rule = 2;
            name = true;
            break;
          case 2:
            rule = this.short(this.fontBase + 0x8) !== 1 ? 7 : 1;
            name = false;
            break;
          case 9:
            base = true;
            rule = 2;
            break;
          case 18:
            rule = 2;
            break;
          case 10:
            ruby = true;
            rule = 11;
            break;
          case 30:
            rule = 11;
            break;
          case 11:
            ruby = false;
            base = false;
            rule = 1;
            break;
        }
      } else if (ruby) rule = 27;
      else if (base || name) rule = 11;
      else {
        if (word(id)) {
          if (word(i ? this.glyph(i - 1) : 0)) rule = 9;
          if (word(this.glyph(i + 1))) rule |= 10;
        }
        if (!rule) {
          for (let j = 0; j < this.get(0x7cb038); j++)
            if (this.short(0x661000 + j * 2) === id) {
              rule = 1;
              break;
            }
          for (let j = 0; j < this.get(0x7fc93c); j++)
            if (this.short(0x80c400 + j * 2) === id) {
              rule |= 2;
              break;
            }
        }
      }
      this.setRule(i, rule);
    }
  }
  wrap(width: number): void {
    const n = this.get(0x737988);
    let i = 0,
      x = this.s.flags[0xbe]! & 1 ? u(this.get(0x732a9c) - this.short(0x7fbd84)) : 0,
      guard = 0;
    const advance = (j: number) => (this.rule(j) & 16 ? 0 : this.metric(j, 2)),
      can = (j: number) => !(this.rule(j) & 2) || this.rule(j) === 7;
    while (i < n) {
      if (++guard > n * 20 + 100) throw new Error('Native text wrapping failed to advance');
      const rule = this.rule(i),
        w = advance(i);
      if (width < u(x + w)) {
        const original = i,
          previous = i - 1;
        let k = previous;
        if (can(k) && !(rule & 1)) {
          this.setRule(k, 7);
          x = 0;
          continue;
        }
        let total = advance(k),
          found = false;
        while (k !== 0 && total < 160) {
          const before = k - 1;
          if (can(before) && !(this.rule(k) & 1)) {
            this.setRule(before, 7);
            i = k;
            x = 0;
            found = true;
            break;
          }
          k = before;
          total = u(total + advance(k));
        }
        if (found) continue;
        total = advance(k);
        i = original + 1;
        while (i < n && total < 60) {
          const before = i - 1;
          if (can(before) && !(this.rule(i) & 1)) {
            this.setRule(before, 7);
            x = 0;
            found = true;
            break;
          }
          total = u(total + advance(before));
          i++;
        }
        if (found) continue;
        if (!(this.rule(previous) & 8)) {
          this.setRule(previous, 7);
          x = 0;
          continue;
        }
        for (i = original + 1; i < n; i++)
          if (can(i - 1) && !(this.rule(i) & 1)) {
            this.setRule(i - 1, 7);
            break;
          }
        x = 0;
      } else {
        x = rule === 7 ? 0 : u(x + w);
        i++;
      }
    }
    if (n && this.rule(n - 1) === 7 && this.glyph(n - 1) !== 0x8000) this.setRule(n - 1, 0);
  }
  protected line(
    start: number,
    end: number,
    hasRuby: number,
    width: number,
    height: number,
    rubyHeight: number,
    y: number,
  ): number {
    const font = this.fontBase,
      short = (off: number) => this.short(font + off),
      signed = (off: number) => this.signed(font + off);
    const max = short(20),
      align = this.get(0x768718);
    let x = 0,
      scale = 65536;
    if (width <= max) {
      if (align === 2) x = max - width;
      else if (align) x = (max - width) >>> 1;
      this.put(0x719a0c, Math.max(this.get(0x719a0c), width));
    } else {
      scale = div(max * 65536, width);
      width = max;
      this.put(0x719a0c, max);
    }
    this.put(0x80f340, u(x + width));
    if ((hasRuby === 1 && short(40) === 0) || short(40) === 1) y = u(y + short(38) + rubyHeight);
    this.put(0x7cb030, u(height + y));
    let name = false,
      ruby = false,
      base = false,
      nameX = height,
      nameY = height,
      nameScale = height,
      rubyX = height,
      rubyGap = height,
      rubyOrigin = height,
      perCharacter = height,
      centers: number[] = [],
      center = 0;
    for (let i = start; i <= end; i++) {
      const id = this.glyph(i),
        fontIndex = this.s.bytes(FONT + i, 1)[0]!,
        setXY = (xx: number, yy: number) => {
          this.put(XY + i * 8, xx);
          this.put(XY + i * 8 + 4, yy);
        };
      if (!(id & 0x8000)) {
        const offset = id < 384 ? (romByte((fontIndex ? 0x1d8ac0 : 0x1d9f00) + id) << 24) >> 24 : 0;
        if (!ruby) {
          if (name) {
            const w = mul(nameScale, this.metric(i, 2)) >>> 7;
            this.setMetric(i, 2, w);
            this.setMetric(i, 3, div(mul(short(18), this.metric(i, 3)), short(28)));
            setXY(nameX, nameY + offset);
            nameX = u(nameX + w);
          } else {
            if (base) {
              centers.push(u((this.metric(i, 2) >>> 1) + x));
            }
            if (scale !== 65536) this.setMetric(i, 2, mul(scale, this.metric(i, 2)) >>> 16);
            setXY(x, u(offset - this.metric(i, 3) + y + height));
            x = u(x + this.metric(i, 2));
            this.put(0x737998, u(y - this.metric(i, 3) + height));
            this.put(0x732a9c, x);
          }
        } else {
          const w = div(mul(short(32), this.metric(i, 2)), short(28)),
            h = div(mul(short(34), this.metric(i, 3)), short(28));
          this.setMetric(i, 2, w);
          this.setMetric(i, 3, h);
          if (!perCharacter) {
            setXY(rubyX, u(y - short(38) - h));
            rubyX = u(rubyX + rubyGap + w);
          } else {
            if (centers[center] === undefined)
              throw new Error('Ruby center reads undefined native scratch');
            setXY(centers[center]! - (center < centers.length ? w >>> 1 : 0), u(y - short(38) - h));
            center++;
            if (center >= centers.length) centers[center] = u(centers[center - 1]! + w);
          }
        }
        continue;
      }
      switch (id & 255) {
        case 1:
          if (short(8) !== 1) {
            name = true;
            let total = 0,
              letters = 0,
              j = i;
            for (; this.glyph(j) !== 0x8002; j++) {
              checkRange(2400, j, 1);
              if (!(this.glyph(j) & 0x8000)) {
                total = u(total + div(mul(mul(short(16), this.metric(j, 2)), 128), short(28)));
                letters++;
              }
            }
            let available = short(10) << 7;
            if (available < total) {
              nameScale = div(available, letters * 32);
              total = available;
            } else {
              nameScale = short(16) << 2;
              if (short(44) & 8) available = Math.max(short(46) << 7, total);
            }
            this.put(
              0x660fc8 + (this.fontBase - 0x7fbd80) / 12,
              short(44) & 8 ? available >>> 7 : total >>> 7,
            );
            if (short(8) === 0) {
              nameX = u(signed(4) + signed(12));
              nameY = u(signed(14) + signed(6));
              if ((short(44) & 7) === 1) nameX = u(nameX - Math.trunc((total | 0) / 256));
              else if ((short(44) & 7) === 2)
                nameX = u(nameX + Math.trunc(((available - total) | 0) / 128));
            } else if (short(8) === 3) {
              nameX = u((available >>> 8) + signed(12));
              nameY = u(signed(14));
              if ((short(44) & 7) === 1) nameX = u(nameX - Math.trunc((total | 0) / 256));
              else if ((short(44) & 7) === 2)
                nameX = u(Math.trunc(((available - total) | 0) / 128) + signed(12));
              else if ((short(44) & 7) === 0) nameX = u(signed(12));
            } else {
              nameX = x;
              nameY = y;
            }
          }
          break;
        case 2:
          name = false;
          break;
        case 9:
          base = true;
          perCharacter = 0;
          centers = [];
          center = 0;
          rubyOrigin = x;
          break;
        case 10: {
          let total = 0,
            n = 0;
          for (let j = i; this.glyph(j) !== 0x800b; j++) {
            checkRange(2400, j, 1);
            if (!(this.glyph(j) & 0x8000)) {
              total = u(total + div(mul(mul(short(32), this.metric(j, 2)), 128), short(28)));
              n++;
            }
          }
          const available = mul(x - rubyOrigin, 128);
          if (available < total) {
            rubyX = u(-((total - available) >>> 8));
            rubyGap = 0;
          } else {
            const space = (available - total) >>> 7;
            rubyGap = div(space, n);
            rubyX = (space - mul(n - 1, rubyGap)) >>> 1;
          }
          rubyX = u(rubyX + rubyOrigin);
          ruby = true;
          break;
        }
        case 11:
          ruby = false;
          base = false;
          break;
        case 18:
          x = u(x + (mul(scale, this.metric(i, 2)) >>> 16));
          break;
        case 30:
          perCharacter = 1;
          break;
      }
    }
    return y;
  }
  /** 1400405f0 with its second argument fixed to zero, as used by 01/12. */
  protected transientLayout(): void {
    const n = this.get(0x737988),
      mode = this.short(this.fontBase + 8),
      lineHeight = this.short(this.fontBase + 36);
    let start = 65535,
      width = 0,
      height = 0,
      y = 0,
      ruby = false,
      hasRuby = 0,
      rubyHeight = this.short(this.fontBase + 34),
      beforeEnd = true;
    this.put(0x719a0c, 0);
    this.put(0x799b1c, 0);
    const flush = (end: number, align = this.get(0x768718)) => {
      const saved = this.get(0x768718);
      this.put(0x768718, align);
      y = this.line(start, end, hasRuby, width, height, rubyHeight, y);
      this.put(0x768718, saved);
    };
    for (let i = 0; i < n; i++) {
      const id = this.glyph(i);
      if (!(id & 0x8000)) {
        if (!ruby) {
          width = u(width + this.metric(i, 2));
          height = Math.max(height, this.metric(i, 3));
          if (start === 65535) start = i;
        }
      } else
        switch (id & 255) {
          case 0:
            beforeEnd = false;
            break;
          case 1:
            if (start === 65535) start = i;
            break;
          case 2:
            if (mode !== 1) {
              const oldY = y;
              flush(i, 0);
              if (mode === 0) y = oldY;
              else if (mode !== 3) y = u(y + lineHeight + height);
              start = 65535;
              width = 0;
              height = 0;
              hasRuby = 0;
              rubyHeight = this.short(this.fontBase + 34);
              ruby = false;
              continue;
            }
            break;
          case 9: {
            hasRuby = 1;
            let j = i + 1;
            while (j < n && this.glyph(j) !== 0x800a) j++;
            for (j++; j < n && this.glyph(j) !== 0x800b; j++)
              rubyHeight = div(
                mul(this.short(this.fontBase + 34), this.metric(j, 3)),
                this.short(this.fontBase + 28),
              );
            if (start === 65535) start = i;
            break;
          }
          case 10:
            ruby = true;
            break;
          case 11:
            ruby = false;
            if (beforeEnd) this.put(0x799b1c, 1);
            break;
          case 18:
            width = u(width + this.metric(i, 2));
            break;
        }
      if (this.rule(i) === 7) {
        flush(i);
        y = u(y + lineHeight + height);
        start = 65535;
        width = 0;
        height = 0;
        hasRuby = 0;
        rubyHeight = this.short(this.fontBase + 34);
        ruby = false;
      }
    }
    if (start !== 65535) flush(n - 1);
    this.put(0x719a00, u(y + height));
  }
  layout(): void {
    const layouts = tokenLayouts(this.s, this.fontBase),
      packed = tipsLayouts(this.s);
    packed.length = this.get(0x732a98);
    const lineOffset = this.get(0x737990),
      rubyOffset = packed.length;
    const n = this.get(0x737988);
    let start = 65535,
      width = 0,
      height = 0,
      ruby = 0,
      hasRuby = 0,
      nextRuby = 0,
      rubyHeight = this.short(this.fontBase + 0x22),
      y = this.get(0x80c3f4);
    this.put(0x719a0c, 0);
    const flush = (end: number) => {
      y = this.line(start, end, hasRuby, width, height, rubyHeight, y);
    };
    for (let i = 0; i < n; i++) {
      const id = this.glyph(i);
      if (!(id & 0x8000)) {
        if (!ruby) {
          width = u(width + this.metric(i, 2));
          height = Math.max(height, this.metric(i, 3));
          if (start === 65535) start = i;
        }
      } else
        switch (id & 255) {
          case 1:
            if (start === 65535) start = i;
            break;
          case 2:
            if (this.short(this.fontBase + 0x8) !== 1) {
              flush(i);
              const mode = this.short(this.fontBase + 0x8);
              if (mode !== 0 && mode !== 3) y = u(y + this.short(this.fontBase + 0x24) + height);
              start = 65535;
              width = 0;
              rubyHeight = this.short(this.fontBase + 0x22);
              hasRuby = nextRuby;
              continue;
            }
            break;
          case 9: {
            nextRuby = 1;
            let j = i + 1;
            while (j < n && this.glyph(j) !== 0x800a) j++;
            for (j++; j < n && this.glyph(j) !== 0x800b; j++)
              rubyHeight = mul(this.short(this.fontBase + 0x22), this.metric(j, 3)) >>> 5;
            hasRuby = 1;
            if (start === 65535) start = i;
            break;
          }
          case 10:
            ruby = 1;
            break;
          case 11:
            ruby = 0;
            break;
          case 18:
            width = u(width + this.metric(i, 2));
            break;
        }
      if (this.rule(i) === 7) {
        this.put(0x732aa0 + this.get(0x737990) * 4, y);
        this.put(0x737990, this.get(0x737990) + 1);
        flush(i);
        y = u(y + this.short(this.fontBase + 0x24) + height);
        width = 0;
        nextRuby = 0;
        ruby = 0;
        hasRuby = 0;
        rubyHeight = this.short(this.fontBase + 0x22);
        start = 65535;
      }
    }
    if (n) {
      if (start !== 65535) {
        this.put(0x732aa0 + this.get(0x737990) * 4, y);
        this.put(0x737990, this.get(0x737990) + 1);
        flush(n - 1);
        y = u(y + this.short(this.fontBase + 0x24) + height);
      }
      this.put(0x80c3f4, y);
    }
    for (let i = 0; i < n; i++)
      if (!(this.glyph(i) & 0x8000)) {
        const j = this.get(0x732a98);
        packed[j] = {
          ...layouts[i]!,
          line: layouts[i]!.role === 'body' ? layouts[i]!.line + lineOffset : layouts[i]!.line,
          role: layouts[i]!.role.startsWith('ruby-')
            ? `${layouts[i]!.role}-${rubyOffset}`
            : layouts[i]!.role,
        };
        this.s.put(0x801440 + j * 2, this.glyph(i), 2);
        this.s.put(0x6e8360 + j, this.s.bytes(STYLE + i, 1)[0]!, 1);
        for (let k = 0; k < 4; k++) this.put(0x661710 + j * 16 + k * 4, this.metric(i, k));
        this.put(0x7fc940 + j * 8, this.get(XY + i * 8));
        this.put(0x7fc940 + j * 8 + 4, this.get(XY + i * 8 + 4));
        this.put(0x732a98, j + 1);
      }
  }
  render(address: number): void {
    this.parse(address);
    this.classify();
    this.wrap(this.short(this.fontBase + 0x14));
    this.layout();
  }
}
