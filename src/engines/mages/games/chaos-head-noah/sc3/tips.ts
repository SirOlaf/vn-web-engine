import type {NoahState} from './noah-state.js';
import {romWord} from './text-rom.js';
import {checkRange} from '../../../../../core/binary.js';

/** Host effects shared with text, pointer hit-testing, UI sound and achievements. */
export interface TipsHost {
  byte(address: number): number;
  message(slot: number, id: number): number;
  layout(address: number): void;
  hit(group: number, index: number, activate: boolean): boolean;
  sound(id: number, volume: number): void;
  achievement(id: number): void;
}
const ENTRY = 0x5a7700,
  COUNTS = 0x5af9d0,
  LIST = 0x5a9b50;
/** 14005b9d0 and 140029080/294f0/2a3a0. State is retained in the native layout. */
export class NoahTips {
  constructor(
    readonly state: NoahState,
    readonly host: TipsHost,
  ) {}
  private get(a: number) {
    return this.state.get(a) >>> 0;
  }
  private put(a: number, v: number) {
    this.state.put(a, v);
  }
  private entry(id: number, field: number) {
    return this.get(ENTRY + id * 28 + field);
  }
  private setEntry(id: number, field: number, v: number) {
    this.put(ENTRY + id * 28 + field, v);
  }
  private count(category: number) {
    return this.get(COUNTS + category * 4);
  }
  private item(category: number, index: number) {
    return this.get(LIST + (category * 300 + index) * 4);
  }
  private append(category: number, item: number) {
    const n = this.count(category);
    this.put(LIST + (category * 300 + n) * 4, item);
    this.put(COUNTS + category * 4, n + 1);
  }
  private bit(index: number) {
    checkRange(this.state.auxiliary.length * 8, index, 1);
    return (this.state.auxiliary[index >>> 3]! >> (index & 7)) & 1;
  }
  private setBit(index: number, v: number) {
    checkRange(this.state.auxiliary.length * 8, index, 1);
    const b = index >>> 3,
      m = 1 << (index & 7);
    this.state.auxiliary[b] = v ? this.state.auxiliary[b]! | m : this.state.auxiliary[b]! & ~m;
  }
  private read(a: number, n: number) {
    let v = 0;
    for (let i = 0; i < n; i++) v += this.host.byte(a + i) * 2 ** (8 * i);
    return v >>> 0;
  }
  initialize(slot: number, entries: number, header: number, language: number): void {
    const en = language === 1,
      rank = en ? 0x20cc80 : 0x20cd80,
      category = en ? 0x20d4c0 : 0x20d230;
    for (const [a, v] of [
      [0x5a97d8, en ? 1 : 255],
      [0x5a9aac, en ? 0 : 1],
      [0x5afaa8, en ? 2 : 14],
      [0x5b0a54, en ? 0 : 255],
      [0x5b0a48, en ? 3 : 13],
      [0x5a9aa8, en ? 5 : 15],
      [0x5b04b4, en ? 4 : 12],
    ])
      this.put(a!, v!);
    this.state.put(0x5afa20, 0x140000000 + (en ? 0x20d3d0 : 0x20cfc0), 8);
    this.state.put(0x5b09e8, 0x140000000 + category, 8);
    this.state.put(0x5b0988, 0x140000000 + rank, 8);
    const alphabet = this.read(header + 4, 4);
    this.put(0x5b0978, alphabet);
    this.put(0x5a9838, slot);
    let count = 0;
    for (let n = this.read(entries, 2); n !== 255; n = this.read(entries, 2)) {
      checkRange(300, count, 1);
      this.setEntry(count, 0, n);
      this.setEntry(count, 4, this.read(entries + 2, 4));
      count++;
      entries += 18 + n * 4;
    }
    this.put(0x5b04bc, count);
    const keys: number[][] = [];
    for (let i = 0; i < count; i++) {
      const alphabetAddress = this.host.message(slot, alphabet);
      let name = this.host.message(slot, (this.entry(i, 4) + 300) >>> 0);
      const key: number[] = [];
      while (this.host.byte(name) !== 255) {
        let a = alphabetAddress,
          k = 0;
        while (
          this.host.byte(a) !== 255 &&
          (this.host.byte(a) !== this.host.byte(name) ||
            this.host.byte(a + 1) !== this.host.byte(name + 1))
        ) {
          a += 2;
          k++;
        }
        key.push(k);
        name += 2;
        checkRange(50, key.length, 1);
      }
      key.push(9999);
      keys.push(key);
      this.put(0x5b04c0 + i * 4, i);
      this.setEntry(i, 8, romWord(rank + key[0]! * 4));
    }
    // Native stable adjacent swaps, including prefix ordering and identical names.
    for (let pass = 0; pass < count; pass++)
      for (let i = 0; i < count - 1; i++) {
        const a = this.get(0x5b04c0 + i * 4),
          b = this.get(0x5b04c4 + i * 4),
          ka = keys[a]!,
          kb = keys[b]!;
        let k = 0;
        while (ka[k] !== 9999 && kb[k] !== 9999 && ka[k] === kb[k]) k++;
        if (ka[k] !== 9999 && (kb[k] === 9999 || ka[k]! > kb[k]!)) {
          this.put(0x5b04c0 + i * 4, b);
          this.put(0x5b04c4 + i * 4, a);
        }
      }
    this.state.zero(COUNTS, 80);
    let next = 0;
    for (let i = 0; i < count; i++) {
      const id = this.get(0x5b04c0 + i * 4),
        group = this.entry(id, 8),
        cat = romWord(category + group * 4);
      this.setEntry(id, 20, i);
      if (next <= group) {
        next = group + 1;
        this.append(cat, group + 10000);
      }
      this.append(cat, id);
    }
  }
  synchronize(): void {
    for (let id = 0; id < this.get(0x5b04bc); id++) {
      this.setEntry(id, 12, 0);
      this.setEntry(id, 16, this.bit(id * 3) + this.bit(id * 3 + 1) * 4 + this.bit(id * 3 + 2) * 2);
    }
  }
  private special(): number {
    if (!(this.state.flags[0x1e4]! & 32)) return 65535;
    const n = this.state.variable(0x1f60 / 4);
    return n === 0
      ? 141
      : (n * 4) >>> 0 < 34
        ? 142
        : (n * 4) >>> 0 < 67
          ? 143
          : (n * 4) >>> 0 > 99
            ? 145
            : 144;
  }
  private achievementFor(id: number): void {
    if ((this.entry(id, 20) | 0) > 140) {
      const n = this.state.variable(0x1f60 / 4);
      if (n === 0) this.host.achievement(32);
      if (n === 25) this.host.achievement(31);
    }
  }
  private description(id: number): void {
    this.put(0x732a98, 0);
    this.put(0x737990, 0);
    this.put(0x80c3f4, 0);
    for (let part = 0; part < this.entry(id, 0); part++) {
      this.host.layout(
        this.host.message(this.get(0x5a9838), (this.entry(id, 4) + 400 + part * 100) >>> 0),
      );
      this.put(0x5a710c, this.get(0x80c3f4) + 10);
    }
    this.setEntry(id, 16, this.entry(id, 16) | 2);
    this.setBit(id * 3 + 2, 1);
  }
  private position(category: number, index: number, scroll = true): void {
    this.put(0x20bb94, category);
    this.put(0x5b046c, index);
    if (scroll && this.count(category) > 13) {
      const offset = Math.min((index - 1) >>> 0, (this.count(category) - 14) >>> 0);
      this.put(0x5b0974, offset);
      this.put(0x5b046c, index - offset);
    }
  }
  prepare(): void {
    const s = this.state;
    this.put(0x5a9aa4, 0);
    this.put(0x5a710c, 0);
    this.put(0x5afa2c, 0);
    const special = this.special();
    let recent = this.get(0x5b0a3c);
    const history = (i: number) => s.view(0x5a9840 + i * 2, 2).getUint16(0, true);
    if (special !== s.variable(0x1f68 / 4)) {
      for (let remove = 141; remove <= 145; remove++)
        for (let i = 0; i < recent; i++)
          if (history(i) === remove) {
            recent--;
            for (let j = i; j < recent; j++) s.put(0x5a9840 + j * 2, history(j + 1), 2);
            break;
          }
      this.put(0x5afa2c, 255);
      for (let i = 141; i <= 145; i++) this.setBit(i * 3, 0);
      if (s.flags[0x1e4]! & 32) {
        this.put(0x5afa2c, special - 141);
        this.setBit(special * 3, 1);
        s.put(0x5a9840 + recent * 2, special, 2);
        recent++;
      }
      this.put(0x5b0a3c, recent);
    }
    s.setVariable(0x1f68 / 4, special);
    const unread = this.get(0x5afaa8),
      fresh = this.get(0x5b0a48),
      specialCategory = this.get(0x5b04b4),
      unlocked = this.get(0x5a97d8),
      all = this.get(0x5b0a54),
      categories = this.get(0x5a9aa8),
      n = this.get(0x5b04bc);
    this.put(COUNTS + fresh * 4, 0);
    this.put(COUNTS + unread * 4, 0);
    for (let i = recent - 1; i >= 0; i--) {
      const id = history(i);
      if (!this.bit(id * 3 + 1)) {
        if (!this.count(fresh)) this.append(fresh, 20000);
        this.append(fresh, id);
      }
    }
    this.synchronize();
    for (let id = 0; id < n; id++)
      if ((this.entry(id, 16) & 3) === 1) {
        if (!this.count(unread)) this.append(unread, 20001);
        this.append(unread, id);
      }
    for (let pass = 0; pass < n; pass++)
      for (let i = 1; i < this.count(unread) - 1; i++) {
        const a = this.item(unread, i),
          b = this.item(unread, i + 1);
        if (this.entry(b, 20) < this.entry(a, 20)) {
          this.put(LIST + (unread * 300 + i) * 4, b);
          this.put(LIST + (unread * 300 + i + 1) * 4, a);
        }
      }
    this.put(COUNTS + specialCategory * 4, 0);
    if (s.flags[0x1e4]! & 32) {
      this.append(specialCategory, 20002);
      this.append(specialCategory, special);
    }
    for (const cat of [unlocked, all])
      if (cat !== 255) {
        this.put(COUNTS + cat * 4, 0);
        let next = 0;
        for (let i = 0; i < n; i++) {
          const id = this.get(0x5b04c0 + i * 4);
          if (id >= 141 || (cat === unlocked && !this.bit(id * 3))) continue;
          const group = this.entry(id, 8);
          if (next <= group) {
            next = group + 1;
            this.append(cat, group + 10000);
          }
          this.append(cat, id);
        }
        if (s.flags[0x1e4]! & 32) {
          this.append(cat, 20002);
          this.append(cat, special);
        }
      }
    let selected = s.variable(0x2430 / 4) >>> 0;
    if (selected < 99999 && !this.bit(selected * 3)) {
      s.setVariable(0x2430 / 4, 99999);
      selected = 99999;
    }
    if (selected === 99999 && recent) {
      selected = history(recent - 1);
      s.setVariable(0x2430 / 4, selected);
    }
    this.put(0x5b046c, 1);
    this.put(0x5b0974, 0);
    this.put(0x20bb94, 99);
    const ordinary = Array.from({length: categories}, (_, i) => i).filter(
      (i) => ![fresh, unread, unlocked, all].includes(i),
    );
    const search = (
      cats: number[],
      predicate: (id: number) => boolean,
      write: boolean,
      scroll = true,
    ) => {
      for (const cat of cats)
        for (let i = 0; i < this.count(cat); i++) {
          const id = this.item(cat, i);
          if (predicate(id)) {
            this.position(cat, i, scroll);
            if (write) s.setVariable(0x2430 / 4, id);
            return true;
          }
        }
      return false;
    };
    if (selected < 99999) search([fresh, ...ordinary], (id) => id === selected, false);
    else if (this.count(fresh)) this.put(0x20bb94, fresh);
    else if (!search(ordinary, (id) => id < 10000 && !!(this.entry(id, 16) & 1), true))
      search(ordinary, (id) => id < 10000, false, false);
    if (this.get(0x20bb94) === 99) {
      if (all === 255) this.put(0x20bb94, 0);
      else if (!search([all], (id) => id < 10000 && !!(this.entry(id, 16) & 1), true)) {
        this.put(0x20bb94, all);
        this.put(0x5b0974, 0);
        this.put(0x5b046c, 1);
      }
    }
    this.put(0x20bbb4, 99999);
    selected = s.variable(0x2430 / 4) >>> 0;
    if (selected < 99999 && this.entry(selected, 16) & 1) {
      this.put(0x20bbb4, selected);
      this.description(selected);
    }
    this.put(0x5a97dc, 0);
    // Native retains 99999 for this rank read if no unlocked description was selected.
    // Preserve the actual read in the bounded global layout rather than skipping it.
    this.achievementFor(selected < 99999 && this.entry(selected, 16) & 1 ? selected : 99999);
  }
  private sound(id: number) {
    const volume =
      Math.trunc(Math.fround(Math.fround(Math.fround(this.get(0x17ac2e8)) * 70) / 100)) >>> 0;
    this.put(0x5a7100, volume);
    this.host.sound(id, volume);
  }
  interact(): void {
    const s = this.state,
      g = (a: number) => this.get(a),
      p = (a: number, v: number) => this.put(a, v),
      held = g(0x5a70d0);
    for (let row = 0; row < 14; row++)
      if (this.host.hit(21, row, true)) {
        p(0x5b046c, row);
        if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
        break;
      }
    if (this.host.hit(22, 0, false)) {
      const wheel = s.get(0x17addd0);
      p(
        0x5b0974,
        Math.max(
          0,
          Math.min(
            Math.max(0, this.count(g(0x20bb94)) - 14),
            (g(0x5b0974) | 0) + (wheel < 0 ? 1 : wheel > 0 ? -1 : 0),
          ),
        ),
      );
    }
    if (this.host.hit(22, 1, false)) {
      const wheel = s.get(0x17addd0);
      p(
        0x5a9aa4,
        Math.max(
          0,
          Math.min(
            Math.max(0, (g(0x5a710c) - 460) | 0),
            (g(0x5a9aa4) | 0) + (wheel < 0 ? 32 : wheel > 0 ? -32 : 0),
          ),
        ),
      );
    }
    for (let cat = 0; cat < 15; cat++)
      if (this.host.hit(20, cat, true)) {
        if (this.count(cat) && g(0x17add90) & 1) {
          p(0x5b0974, 0);
          p(0x5b046c, 0);
          this.advance(cat, 1);
        }
        break;
      }
    const pressed = g(0x5a70d4),
      repeat = g(0x5a6f74);
    if (
      s.bytes(0x543836, 1)[0] === 0 &&
      (s.bytes(0x586a58, 1)[0]! & 2 || pressed & g(0x872dd8) || g(0x17add90) & 2)
    ) {
      this.sound(3);
      return;
    }
    const cat = g(0x20bb94);
    if (pressed & g(0x872dd4) && this.count(cat)) {
      const oldRow = g(0x5b046c),
        id = this.item(cat, (oldRow + g(0x5b0974)) >>> 0);
      if (!(this.entry(id, 16) & 1)) this.sound(4);
      else if (id !== g(0x20bbb4)) {
        this.sound(2);
        p(0x20bbb4, id);
        s.setVariable(0x2430 / 4, id);
        this.achievementFor(id);
        p(0x5a9aa4, 0);
        this.description(id);
      }
      if (g(0x5afa2c) !== 255 && cat === g(0x5b04b4)) p(0x5b046c, oldRow);
      return;
    }
    let axis = g(0x5a97dc);
    if (axis === 1 && !(held & (g(0x872e40) | g(0x872e44)))) axis = 0;
    if (axis === 2 && !(held & (g(0x872e48) | g(0x872e4c)))) axis = 0;
    if (!axis) {
      if (held & (g(0x872e40) | g(0x872e44))) axis = 1;
      else if (held & (g(0x872e48) | g(0x872e4c))) axis = 2;
    }
    p(0x5a97dc, axis);
    const height = g(0x5a710c) | 0;
    if (axis === 1) {
      if (held & g(0x872e40)) p(0x5a9aa4, (g(0x5a9aa4) | 0) < 9 ? 0 : g(0x5a9aa4) - 8);
      if (held & g(0x872e44)) {
        if ((g(0x5a9aa4) | 0) < height - 468) p(0x5a9aa4, g(0x5a9aa4) + 8);
        else if (height > 460) p(0x5a9aa4, height - 460);
      }
    }
    if (axis === 2) {
      if (repeat & g(0x872e48)) {
        if (g(0x5a9aa4)) this.sound(1);
        p(0x5a9aa4, (g(0x5a9aa4) | 0) < 461 ? 0 : g(0x5a9aa4) - 460);
      }
      if (repeat & g(0x872e4c)) {
        if (g(0x5a9aa4) !== (height - 460) >>> 0 && height > 460) this.sound(1);
        if ((g(0x5a9aa4) | 0) < height - 920) p(0x5a9aa4, g(0x5a9aa4) + 460);
        else if (height > 460) p(0x5a9aa4, height - 460);
      }
    }
    for (const [mask, direction] of [
      [0x872e30, -1],
      [0x872e34, 1],
    ])
      if (repeat & g(mask!)) {
        if (!this.count(cat)) p(0x5b046c, 0);
        else {
          this.sound(1);
          if (cat !== g(0x5b04b4)) this.advance(cat, direction!);
        }
      }
    for (const [mask, direction] of [
      [0x872e38, -1],
      [0x872e3c, 1],
    ])
      if (repeat & g(mask!)) {
        this.sound(1);
        let next = g(0x20bb94),
          found = false;
        for (let i = 0; i < g(0x5a9aa8) + 1; i++) {
          next =
            direction === -1 ? (next || g(0x5a9aa8)) - 1 : next >= g(0x5a9aa8) - 1 ? 0 : next + 1;
          if (g(0x5afa2c) === 255 && next === g(0x5b04b4)) next += direction!;
          if (this.count(next)) {
            found = true;
            break;
          }
        }
        if (!found) throw new Error('TIPS category navigation has no selectable category');
        p(0x20bb94, next);
        p(0x5b0974, 0);
        p(0x5b046c, 0);
        this.advance(next, 1);
      }
  }
  private advance(cat: number, direction: number): void {
    const n = this.count(cat);
    let row = this.get(0x5b046c),
      scroll = this.get(0x5b0974);
    for (let guard = 0; guard <= n; guard++) {
      if (direction < 0) {
        if (row === 1) {
          if (scroll) scroll--;
          else row--;
        } else if (row || scroll) row--;
        else {
          row = n < 15 ? n - 1 : 13;
          scroll = n < 15 ? 0 : n - 14;
        }
      } else if (row === 13 && scroll + 14 < n) scroll++;
      else if ((n < 14 && row === n - 1) || (scroll + 14 === n && row === 13)) {
        row = 0;
        scroll = 0;
      } else row++;
      this.put(0x20bb94, cat);
      this.put(0x5b046c, row);
      this.put(0x5b0974, scroll);
      if (this.item(cat, (row + scroll) >>> 0) < 10000) return;
    }
    throw new Error('TIPS category contains no selectable entry');
  }
}
