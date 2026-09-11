import {tokenLayouts, packedLayouts} from './dom-text-data.js';
import {TipsText} from './tips-text.js';
import {romByte, romWord} from './text-rom.js';
import {checkRange} from '../../../../../core/binary.js';
const FONT = 0x7fbfa0,
  XY = 0x732dc0;
const u = (n: number) => n >>> 0,
  mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
const div = (a: number, b: number) => {
  if (!b) throw new Error('Native text division by zero');
  return Math.floor((a >>> 0) / (b >>> 0)) >>> 0;
};
/** Native scene layout/timing, distinct from TIPS/history layout (140042390). */
export class SceneText extends TipsText {
  private sceneLine(
    start: number,
    end: number,
    hasRuby: number,
    width: number,
    height: number,
    rubyHeight: number,
    y: number,
    origin: number,
  ): number {
    const font = this.fontBase,
      short = (off: number) => this.short(font + off),
      signed = (off: number) => this.signed(font + off);
    const max = short(20),
      align = this.get(0x768718);
    let x = origin,
      scale = 65536;
    if (width <= max) {
      if (align === 2) x = u(x + max - width);
      else if (align) x = u(x + ((max - width) >>> 1));
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
      center = 0,
      centerCount = 0;
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
            setXY(centers[center]! - (center < centerCount ? w >>> 1 : 0), u(y - short(38) - h));
            center++;
            if (center >= centerCount) centers[center] = u(centers[center - 1]! + w);
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
          centerCount = centers.length;
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
  /** 140040bb0: weighted reveal schedule, ruby and embedded event times. */
  private timing(duration: number): void {
    if (!this.get(0x6610c8)) return;
    const per = (count: number) => (count ? div(duration, count) : duration >>> 0);
    let step = per(this.get(this.get(0x799b18) ? 0x80f350 : 0x6610c8)),
      name = false,
      hidden = false,
      ruby = 0,
      time = 0,
      rubyTime = 0,
      rubyStep = 0,
      page = 0,
      event = 0,
      marker = 0;
    const weight = (id: number) => {
      for (let a = 0x1d7828; romWord(a) !== 65535; a += 8)
        if (romWord(a) === id) return romWord(a + 4);
      return undefined;
    };
    for (let i = 0; i < this.get(0x737988); i++) {
      const id = this.glyph(i),
        put = (t: number) => this.put(0x66b350 + i * 4, t);
      if (!(id & 0x8000)) {
        if (hidden) {
          put(-1);
          continue;
        }
        if (ruby === 2) {
          put(rubyTime);
          rubyTime = u(rubyTime + rubyStep);
          continue;
        }
        let w = weight(id);
        if (w === undefined) {
          let n = 0;
          while (romWord(0x1da108 + n * 4) !== 65535 && romWord(0x1da108 + n * 4) !== id) n++;
          // The native second lookup deliberately uses n*8, not n*4.
          if (
            id === romWord(0x1da108 + n * 8) &&
            i !== 0 &&
            weight(this.glyph(i - 1)) !== undefined
          ) {
            put(this.get(0x66b350 + (i - 1) * 4));
            hidden = name;
            continue;
          }
          w = 1;
        }
        if (w !== 0) {
          put(time);
          time = u(time + mul(w, step));
        }
        hidden = name;
        continue;
      }
      switch (id & 255) {
        case 1:
          hidden = name = true;
          continue;
        case 2:
          hidden = name = false;
          continue;
        case 7:
          time = u(time + mul(step, this.metric(i, 0)));
          break;
        case 9:
          ruby = 1;
          rubyTime = time;
          break;
        case 10: {
          let count = 0;
          for (let j = i + 1; this.glyph(j) !== 0x800b; j++) {
            checkRange(2400, j, 1);
            hidden = !!(this.glyph(j) & 0x8000);
            if (!hidden) count++;
          }
          rubyStep = count ? div(u(time - rubyTime), count) : 0;
          ruby = 2;
          break;
        }
        case 11:
          ruby = 0;
          break;
        case 14:
          page++;
          time = 0;
          step = per(this.get(0x80f350 + page * 4));
          break;
        case 21:
          this.put(0x7378c0 + event++ * 4, time);
          break;
        case 22:
          this.put(0x79a250 + marker++ * 4, time);
          break;
        case 3:
        case 4:
        case 5:
        case 6:
        case 8:
        case 12:
        case 13:
        case 15:
        case 16:
        case 17:
        case 18:
        case 19:
        case 20:
          break;
        default:
          continue;
      }
      hidden = name;
    }
  }
  /** 140040040: persistent origin/continuation and scene control tokens. */
  private arrange(slot: number): void {
    const b = slot * 0x11984,
      s = this.s,
      sh = (o: number) => this.short(this.fontBase + o),
      si = (o: number) => this.signed(this.fontBase + o);
    this.put(0x719a0c, 0);
    this.put(0x5b10a8 + b, 0);
    let height = 0,
      x = this.get(0x732a9c),
      y = this.get(0x660ffc),
      start = 65535,
      width = 0,
      hasRuby = 0,
      ruby = false,
      rubyHeight = sh(34);
    if (!(s.flags[0xbe]! & 1)) {
      x = u(si(4) + this.get(0x5b10b8 + b));
      y = u(si(6) + this.get(0x5b10bc + b));
      this.put(0x660ffc, y);
    } else {
      s.flags[0xbe] = s.flags[0xbe]! & ~1;
      height = this.get(0x7686e4);
    }
    let lineX = x,
      lineY = y;
    const flush = (end: number) => {
      lineY = this.sceneLine(start, end, hasRuby, width, height, rubyHeight, lineY, lineX);
    };
    const n = this.get(0x737988);
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
            if (sh(8) !== 1) {
              lineX = u(si(4) + this.get(0x5b10b8 + b));
              flush(i);
              if (sh(8) !== 0 && sh(8) !== 3) y = u(sh(36) + lineY + height);
              rubyHeight = sh(34);
              height = 0;
              width = 0;
              start = 65535;
              lineY = y;
              lineX = x;
              continue;
            }
            break;
          case 3:
            this.put(0x5b10a8 + b, 1);
            break;
          case 5:
            this.put(0x5b10a8 + b, 0);
            break;
          case 8:
            this.put(0x5b10a8 + b, 2);
            break;
          case 9: {
            hasRuby = 1;
            let j = i + 1;
            while (j < n && this.glyph(j) !== 0x800a) j++;
            for (j++; j < n && this.glyph(j) !== 0x800b; j++)
              rubyHeight = div(mul(sh(34), this.metric(j, 3)), sh(28));
            if (start === 65535) start = i;
            break;
          }
          case 10:
            ruby = true;
            break;
          case 11:
            ruby = false;
            break;
          case 17:
            y = u(y + this.metric(i, 0));
            this.put(0x660ffc, y);
            lineY = y;
            break;
          case 18:
            width = u(width + this.metric(i, 2));
            if (start === 65535) start = i;
            break;
          case 23:
            this.put(0x5b10e0 + b, 1);
            break;
          case 24:
            this.put(0x5b10a8 + b, 3);
            break;
          case 25:
          case 26:
            this.put(0x5b10a8 + b, (id & 255) === 25 ? 4 : 5);
            this.put(0x5b10dc + b, this.metric(i, 0) << 8);
            break;
        }
      if (this.rule(i) === 7) {
        flush(i);
        width = 0;
        x = u(si(4));
        rubyHeight = sh(34);
        y = u(lineY + sh(36) + height);
        height = 0;
        hasRuby = 0;
        ruby = false;
        start = 65535;
        this.put(0x660ffc, y);
        lineY = y;
        lineX = x;
      }
    }
    if (n && start !== 65535) {
      flush(n - 1);
      y = lineY;
    }
    this.put(0x7686e4, height);
    this.put(0x5b10b8 + b, 0);
    this.put(0x5b10bc + b, u(sh(36) + y + sh(42) - si(6) + height));
  }
  /** 14003ed60: pack native per-slot glyph arrays without host rendering. */
  private pack(slot: number, shadow = 0): void {
    const s = this.s,
      b = slot * 0x11984,
      layouts = tokenLayouts(s, this.fontBase),
      packed = packedLayouts(s, slot),
      count = this.get(0x5b10ac + b);
    packed.length = count;
    // Continuation appends to the same native buffer. The baseline decides whether
    // its first body line continues the preceding line; font changes do not split it.
    let lineOffset = 0,
      previousBody = -1;
    for (let j = count - 1; j >= 0; j--)
      if (packed[j]?.role === 'body') {
        lineOffset = packed[j]!.line;
        previousBody = j;
        break;
      }
    let firstBody = true;
    for (let i = 0; i < this.get(0x737988); i++) {
      const id = this.glyph(i);
      if (id & 0x8000 || !this.metric(i, 2)) continue;
      const out = this.get(0x5b10ac + b),
        layout = {...layouts[i]!};
      if (layout.role === 'body' && firstBody) {
        firstBody = false;
        if (previousBody >= 0) {
          const j = previousBody,
            oldId = s.bytes(0x5b8ac4 + b + j, 1)[0]! * 64 + s.bytes(0x5b8164 + b + j, 1)[0]!,
            oldFont = s.get(0x5b10e4 + b + j * 4),
            newFont = s.bytes(0x7fbfa0 + i, 1)[0]!,
            offset = (id: number, font: number) =>
              id < 384 ? (romByte((font ? 0x1d8ac0 : 0x1d9f00) + id) << 24) >> 24 : 0,
            oldBaseline =
              s.view(0x5bb9a4 + b + j * 2, 2).getInt16(0, true) -
              offset(oldId, oldFont) +
              s.view(0x5bdf24 + b + j * 2, 2).getUint16(0, true),
            newBaseline =
              this.signed(0x732dc0 + i * 8 + 4) - offset(id, newFont) + this.metric(i, 3);
          if (newBaseline !== oldBaseline && layout.line === 0) lineOffset++;
        }
      }
      if (layout.role === 'body') layout.line += lineOffset;
      // Every auxiliary choice row is an independent text location.
      if (slot >= 5) layout.role = `row-${shadow}/${layout.role}`;
      else if (layout.role.startsWith('ruby-')) layout.role += `-${count}`;
      packed[out] = layout;
      const color = s.bytes(0x719a10 + i, 1)[0]!;
      this.put(0x5b3664 + b + out * 4, romWord(0x20db90 + color * 8));
      this.put(0x5b5be4 + b + out * 4, romWord(0x20db94 + color * 8));
      this.put(0x5b10e4 + b + out * 4, s.bytes(0x7fbfa0 + i, 1)[0]!);
      for (const [a, v] of [
        [0x5b8ac4, id >>> 6],
        [0x5b8164, id & 63],
        [0x5b9424, this.metric(i, 0)],
        [0x5b9d84, this.metric(i, 1)],
        [0x5bf1e4, shadow],
        [0x5c20c4, 0],
      ])
        s.put(a! + b + out, v!, 1);
      for (const [a, v] of [
        [0x5ba6e4, this.get(0x732dc0 + i * 8)],
        [0x5bb9a4, this.get(0x732dc0 + i * 8 + 4)],
        [0x5bcc64, this.metric(i, 2)],
        [0x5bdf24, this.metric(i, 3)],
      ])
        s.put(a! + b + out * 2, v!, 2);
      this.put(0x5bfb44 + b + out * 4, this.get(0x66b350 + i * 4));
      this.put(0x5b10ac + b, out + 1);
    }
  }
  /** 01/12's choice-row text pipeline: parse mode 2, font 6, transient layout and slot 7 packing. */
  prepareChoice(address: number): {width: number; height: number; row: number} {
    this.parse(address, 2, 6, 0);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    this.transientLayout();
    const row = this.s.get(0x660ff0);
    this.pack(7, row);
    return {width: this.get(0x719a0c), height: this.get(0x719a00), row};
  }
  /** 01/14 uses the same native parse/layout calls, but packs into slots 5/6. */
  prepareMenuChoice(address: number, index: number): {width: number; height: number; row: number} {
    this.parse(address, 2, 6, 0);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    this.transientLayout();
    const row = this.s.get(0x80bd08 + index * 4);
    this.pack(index + 5, row);
    return {width: this.get(0x719a0c), height: this.get(0x719a00), row};
  }
  prepare(address: number, slot: number, font: number, duration: number, color: number): number {
    this.put(0x660ff8, 0);
    this.parse(address, 0, font, color);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    let weight = this.get(0x6610c8);
    if (this.get(0x799b18)) {
      weight = 0;
      for (let i = 0; i <= this.get(0x7fbf64); i++)
        weight = Math.max(weight, this.get(0x80f350 + i * 4));
    }
    let total = mul(duration || weight, duration ? 0x300 : 0x600);
    if (this.s.flags[0x139]! & 2) {
      this.s.flags[0x139] = this.s.flags[0x139]! & ~2;
      total = 0;
    }
    this.timing(total);
    this.put(0x5b10a4 + slot * 0x11984, total);
    this.arrange(slot);
    this.pack(slot);
    const name = this.get(0x660ff8),
      b = slot * 0x11984;
    this.put(0x5b10b0 + b, 1);
    this.put(0x80c4d0 + slot * 4, name);
    if (name) this.put(0x80cff0 + slot * 4, 256);
    for (const [target, source] of [
      [0x5b10c0, 0x80f340],
      [0x5b10c4, 0x7cb030],
      [0x5b10c8, 0x732a9c],
      [0x5b10cc, 0x737998],
      [0x5b10d0, 0x719a0c],
      [0x5b10d4, 0x719a00],
    ])
      this.put(target! + b, this.get(source!));
    this.s.put(0x5b10b6 + b, name, 1);
    return weight;
  }
}
