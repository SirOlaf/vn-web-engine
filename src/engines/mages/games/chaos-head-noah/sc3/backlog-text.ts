import {tokenLayouts, historyLayouts} from './dom-text-data.js';
import {TipsText} from './tips-text.js';
/** 1400405f0 + 1400438c0. Text history reuses parsing/breaking/line geometry,
 * but owns a 400-entry metadata ring and a separate 50,000-token ring. */
export class BacklogText extends TipsText {
  private arrange(firstRuby: number): void {
    const n = this.get(0x737988),
      font = this.fontBase,
      short = (off: number) => this.short(font + off);
    let y = 0,
      start = 65535,
      width = 0,
      height = 0,
      ruby = false,
      hasRuby = 0,
      nextRuby = 0,
      rubyHeight = short(34),
      firstLine = true;
    let adjustName = false,
      nameStart = 0,
      nameEnd = 0,
      nameRubyHeight = 0;
    this.put(0x719a0c, 0);
    this.put(0x799b1c, 0);
    const flush = (end: number) => {
      y = this.line(start, end, hasRuby, width, height, rubyHeight, y);
    };
    for (let i = 0; i < n; i++) {
      const id = this.glyph(i);
      if (!(id & 0x8000)) {
        if (!ruby) {
          width = (width + this.metric(i, 2)) >>> 0;
          height = Math.max(height, this.metric(i, 3));
          if (start === 65535) start = i;
        }
      } else
        switch (id & 255) {
          case 0:
            firstLine = false;
            break;
          case 1:
            if (start === 65535) start = i;
            break;
          case 2:
            if (short(8) !== 1) {
              const alignment = this.get(0x768718),
                previousY = y;
              this.put(0x768718, 0);
              flush(i);
              this.put(0x768718, alignment);
              if (short(8) === 0) y = previousY;
              if (firstRuby === 1 && short(8) === 0) {
                adjustName = true;
                nameStart = start;
                nameEnd = i;
                nameRubyHeight = rubyHeight;
              } else if (short(8) !== 0 && short(8) !== 3) y = (y + short(36) + height) >>> 0;
              rubyHeight = short(34);
              start = 65535;
              width = 0;
              hasRuby = nextRuby;
              continue;
            }
            break;
          case 9: {
            nextRuby = 1;
            let j = i + 1;
            while (j < n && this.glyph(j) !== 0x800a) j++;
            for (j++; j < n && this.glyph(j) !== 0x800b; j++) {
              if (!short(28)) throw new Error('Native backlog ruby division by zero');
              rubyHeight = Math.floor((Math.imul(short(34), this.metric(j, 3)) >>> 0) / short(28));
            }
            hasRuby = 1;
            if (start === 65535) start = i;
            break;
          }
          case 10:
            ruby = true;
            break;
          case 11:
            ruby = false;
            if (firstLine) this.put(0x799b1c, 1);
            break;
          case 18:
            width = (width + this.metric(i, 2)) >>> 0;
            break;
        }
      if (this.rule(i) === 7) {
        firstLine = false;
        flush(i);
        rubyHeight = short(34);
        y = (y + short(36) + height) >>> 0;
        width = 0;
        ruby = false;
        start = 65535;
        nextRuby = 0;
        hasRuby = 0;
      }
    }
    if (n && start !== 65535) flush(n - 1);
    if (this.get(0x799b1c) === 1 && adjustName) {
      let inside = false;
      for (let i = nameStart; i <= nameEnd; i++) {
        const id = this.glyph(i);
        if (id & 0x8000) {
          if ((id & 255) === 1) inside = true;
          else if ((id & 255) === 2) inside = false;
        } else if (inside) this.put(0x732dc0 + i * 8 + 4, short(38) + nameRubyHeight);
      }
    }
    this.put(0x719a00, n ? (y + height) >>> 0 : 0);
  }
  /** Complete native history append. Parsing side effects precede ring eviction. */
  append(address: number, voice = -1, voiceBank = 0, tag = 65535): void {
    const firstRuby = this.parse(address, 1, 8, 10);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    this.arrange(firstRuby);
    this.colorName(0x3d);
    this.store(voice, voiceBank, tag);
  }
  /** 140043f40: quoted history, with fixed color and no name recoloring. */
  appendQuoted(address: number): void {
    this.parse(address, 3, 8, 0x1d);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    this.arrange(0);
    this.store(-1, 0, 65535);
  }
  /** 140043c00: explicitly styled history; flag chooses parser mode 4 or 5. */
  appendStyled(address: number, color: number, nameColor: number, center: number): void {
    this.parse(address, center !== 0 ? 5 : 4, 8, color);
    this.classify();
    this.wrap(this.short(this.fontBase + 20));
    this.arrange(0);
    this.colorName(nameColor);
    this.store(-1, 0, 65535);
  }
  private colorName(color: number): void {
    const s = this.s,
      count = this.get(0x737988);
    let insideName = false;
    for (let i = 0; i < count; i++) {
      const id = this.glyph(i);
      if (id & 0x8000) {
        if ((id & 255) === 1) insideName = true;
        else if ((id & 255) === 2) insideName = false;
      } else if (insideName) s.put(0x719a10 + i, color, 1);
    }
  }
  /** Identical metadata/token ring writes in all three native append routines. */
  private store(voice: number, voiceBank: number, tag: number): void {
    const s = this.s,
      count = this.get(0x737988),
      height = this.get(0x719a00),
      layouts = tokenLayouts(s, this.fontBase),
      packed = historyLayouts(s);
    const evict = () => {
      const head = this.get(0x73799c);
      if (head >= 400) throw new Error('Native history head outside metadata ring');
      this.put(0x7fbf60, this.get(0x7fbf60) - this.get(0x66d8e0 + head * 4));
      this.put(0x66d8e0 + head * 4, 0);
      this.put(0x810074, this.get(0x810074) - 1);
      this.put(0x73799c, head === 399 ? 0 : head + 1);
    };
    if (this.get(0x810074) === 400) evict();
    for (let guard = 0; (count + this.get(0x7fbf60)) >>> 0 > 50000; guard++) {
      if (guard >= 400) throw new Error('Native history cannot evict enough tokens');
      evict();
    }
    this.put(0x810074, this.get(0x810074) + 1);
    const entry = this.get(0x732a1c),
      begin = this.get(0x719a04);
    if (entry >= 400 || begin >= 50000) throw new Error('Native history insertion outside ring');
    this.put(0x7cb040 + entry * 4, begin);
    this.put(0x8106c0 + entry * 8, voice);
    this.put(0x66d8e0 + entry * 4, count);
    this.put(0x7379a0 + entry * 4, height);
    this.put(0x732a1c, entry === 399 ? 0 : entry + 1);
    this.put(0x8106c4 + entry * 8, voiceBank);
    this.put(0x6e8cc0 + entry * 4, tag);
    this.put(0x768720 + entry * 4, this.get(0x799b1c));
    for (let i = 0; i < count; i++) {
      const out = this.get(0x719a04);
      packed.set(out, layouts[i]!);
      s.put(0x6cf810 + out * 2, this.glyph(i), 2);
      this.put(0x719a04, out === 49999 ? 0 : out + 1);
      // Native packs the low word of each dword coordinate and the low byte
      // of each dword metric; it does not copy contiguous source bytes.
      s.put(0x79a2f0 + out * 4, this.short(0x732dc0 + i * 8), 2);
      s.put(0x79a2f2 + out * 4, this.short(0x732dc0 + i * 8 + 4), 2);
      for (let c = 0; c < 4; c++)
        s.put(0x69ead0 + out * 4 + c, s.bytes(0x802700 + i * 16 + c * 4, 1)[0]!, 1);
      s.put(0x7266c0 + out, s.bytes(0x719a10 + i, 1)[0]!, 1);
      s.put(0x71a370 + out, s.bytes(0x7fbfa0 + i, 1)[0]!, 1);
    }
    this.put(0x7fbf60, this.get(0x7fbf60) + count);
  }
}
