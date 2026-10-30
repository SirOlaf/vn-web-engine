/**
 * `tTVPRect` and `tTVPComplexRect` (krkrz `visual/ComplexRect.cpp`). A complex rectangle is a
 * set of non-overlapping rectangles kept in a circular list sorted by upper-left point, with
 * adjacent rectangles of equal height united on insertion. Update regions, exposed regions and
 * caches are complex rectangles; the order of their rectangles decides the order in which
 * regions are drawn, so the list operations follow the native ones step by step.
 */

/** `tTVPRect`: integer edges, `right`/`bottom` exclusive. */
export class TvpRect {
  constructor(
    public left = 0,
    public top = 0,
    public right = 0,
    public bottom = 0,
  ) {}

  static from(r: TvpRect): TvpRect {
    return new TvpRect(r.left, r.top, r.right, r.bottom);
  }

  get width(): number {
    return (this.right - this.left) | 0;
  }

  get height(): number {
    return (this.bottom - this.top) | 0;
  }

  set width(w: number) {
    this.right = (this.left + w) | 0;
  }

  set height(h: number) {
    this.bottom = (this.top + h) | 0;
  }

  assign(r: TvpRect): this {
    this.left = r.left;
    this.top = r.top;
    this.right = r.right;
    this.bottom = r.bottom;
    return this;
  }

  set(left: number, top: number, right: number, bottom: number): this {
    this.left = left | 0;
    this.top = top | 0;
    this.right = right | 0;
    this.bottom = bottom | 0;
    return this;
  }

  addOffsets(x: number, y: number): void {
    this.left = (this.left + x) | 0;
    this.right = (this.right + x) | 0;
    this.top = (this.top + y) | 0;
    this.bottom = (this.bottom + y) | 0;
  }

  setOffsets(x: number, y: number): void {
    const w = this.width,
      h = this.height;
    this.left = x | 0;
    this.top = y | 0;
    this.right = (x + w) | 0;
    this.bottom = (y + h) | 0;
  }

  setSize(w: number, h: number): void {
    this.right = (this.left + w) | 0;
    this.bottom = (this.top + h) | 0;
  }

  clear(): void {
    this.left = this.top = this.right = this.bottom = 0;
  }

  isEmpty(): boolean {
    return this.left >= this.right || this.top >= this.bottom;
  }

  /** `do_union`: false (and no change) when `ref` is empty. */
  doUnion(ref: TvpRect): boolean {
    if (ref.isEmpty()) return false;
    if (this.left > ref.left) this.left = ref.left;
    if (this.top > ref.top) this.top = ref.top;
    if (this.right < ref.right) this.right = ref.right;
    if (this.bottom < ref.bottom) this.bottom = ref.bottom;
    return true;
  }

  /** `clip`: the intersection with `ref`; unchanged and false when there is none. */
  clip(ref: TvpRect): boolean {
    return intersectRect(this, this, ref);
  }

  intersectsWithNoEmptyCheck(ref: TvpRect): boolean {
    return !(
      this.left >= ref.right ||
      this.top >= ref.bottom ||
      this.right <= ref.left ||
      this.bottom <= ref.top
    );
  }

  intersectsWith(ref: TvpRect): boolean {
    if (ref.isEmpty() || this.isEmpty()) return false;
    return this.intersectsWithNoEmptyCheck(ref);
  }

  includedInNoEmptyCheck(ref: TvpRect): boolean {
    return (
      ref.left <= this.left &&
      ref.top <= this.top &&
      ref.right >= this.right &&
      ref.bottom >= this.bottom
    );
  }

  includedIn(ref: TvpRect): boolean {
    if (ref.isEmpty() || this.isEmpty()) return false;
    return this.includedInNoEmptyCheck(ref);
  }

  /** `operator <`: by top, then left. */
  lessThan(rhs: TvpRect): boolean {
    return this.top < rhs.top || (this.top === rhs.top && this.left < rhs.left);
  }

  greaterThan(rhs: TvpRect): boolean {
    return this.top > rhs.top || (this.top === rhs.top && this.left > rhs.left);
  }

  equals(rhs: TvpRect): boolean {
    return (
      this.top === rhs.top &&
      this.left === rhs.left &&
      this.right === rhs.right &&
      this.bottom === rhs.bottom
    );
  }
}

/** `TVPIntersectRect`: writes `dest` only when the intersection is not empty. */
export function intersectRect(dest: TvpRect | null, src1: TvpRect, src2: TvpRect): boolean {
  const left = Math.max(src1.left, src2.left);
  const top = Math.max(src1.top, src2.top);
  const right = Math.min(src1.right, src2.right);
  const bottom = Math.min(src1.bottom, src2.bottom);
  if (right > left && bottom > top) {
    dest?.set(left, top, right, bottom);
    return true;
  }
  return false;
}

/** `TVPUnionRect`. */
export function unionRect(dest: TvpRect | null, src1: TvpRect, src2: TvpRect): boolean {
  const left = Math.min(src1.left, src2.left);
  const top = Math.min(src1.top, src2.top);
  const right = Math.max(src1.right, src2.right);
  const bottom = Math.max(src1.bottom, src2.bottom);
  if (right > left && bottom > top) {
    dest?.set(left, top, right, bottom);
    return true;
  }
  return false;
}

/** `tTVPRegionRect`: a rectangle linked into a complex rectangle's circular list. */
class RegionRect extends TvpRect {
  prev: RegionRect = this;
  next: RegionRect = this;

  linkBefore(r: RegionRect): void {
    const p = r.prev;
    r.prev = this;
    p.next = this;
    this.prev = p;
    this.next = r;
  }

  unlink(): void {
    const prev = this.prev,
      next = this.next;
    prev.next = next;
    next.prev = prev;
  }
}

/**
 * `GetRectangleIntersectionCode`: how `rr` covers the edges of `r` (8 left, 4 right, 2 top,
 * 1 bottom).
 */
function intersectionCode(r: TvpRect, rr: TvpRect): number {
  let cond = rr.left <= r.left && rr.right >= r.left ? 8 : 0;
  if (rr.left <= r.right && rr.right >= r.right) cond |= 4;
  if (rr.top <= r.top && rr.bottom >= r.top) cond |= 2;
  if (rr.top <= r.bottom && rr.bottom >= r.bottom) cond |= 1;
  return cond;
}

/** `tTVPComplexRect`. */
export class TvpComplexRect {
  #head: RegionRect | null = null;
  /** The rectangle touched last; insertion searches from it. */
  #current: RegionRect | null = null;
  #count = 0;
  #bound = new TvpRect();
  #boundValid = false;

  /** The copy constructor. */
  static from(ref: TvpComplexRect): TvpComplexRect {
    const c = new TvpComplexRect();
    c.assign(ref);
    return c;
  }

  /** `operator =` as the copy constructor does it (the bound is copied as it is). */
  assign(ref: TvpComplexRect): this {
    if (ref === this) return this;
    this.clear();
    this.#bound.assign(ref.#bound);
    this.#boundValid = false;
    let cur = ref.#head;
    if (cur) {
      const head = cur;
      let last: RegionRect | null = null;
      do {
        const n = new RegionRect(cur.left, cur.top, cur.right, cur.bottom);
        if (!last) this.#head = n;
        else n.linkBefore(this.#head!);
        last = n;
        cur = cur.next;
      } while (cur !== head);
      this.#count = ref.#count;
      this.#current = this.#head;
    }
    return this;
  }

  get count(): number {
    return this.#count;
  }

  clear(): void {
    this.#head = null;
    this.#current = null;
    this.#count = 0;
    this.#bound.clear();
    this.#boundValid = false;
  }

  /** The rectangles in list order. */
  *[Symbol.iterator](): IterableIterator<TvpRect> {
    const head = this.#head;
    if (!head || !this.#count) return;
    let c = head;
    do {
      const next = c.next;
      yield c;
      c = next;
    } while (c !== head);
  }

  /** Copies of the rectangles in list order. */
  rects(): TvpRect[] {
    return [...this].map((r) => TvpRect.from(r));
  }

  get bound(): TvpRect {
    this.#ensureBound();
    return this.#bound;
  }

  /** `Unite`: the bounding rectangle as the only rectangle. */
  unite(): void {
    const r = TvpRect.from(this.bound);
    this.clear();
    this.or(r);
  }

  #ensureBound(): void {
    if (!this.#boundValid) this.#calcBound();
  }

  #calcBound(): void {
    const head = this.#head;
    if (this.#count && head) {
      this.#bound.assign(head);
      for (let c = head.next; c !== head; c = c.next) this.#bound.doUnion(c);
    } else {
      this.#bound.clear();
    }
  }

  /** `Insert`: in place, uniting with a horizontal neighbour of equal rows; no bound update. */
  #insert(rect: TvpRect): boolean {
    if (rect.isEmpty()) return false;
    if (!this.#count || !this.#head || !this.#current) {
      const n = new RegionRect(rect.left, rect.top, rect.right, rect.bottom);
      this.#head = this.#current = n;
      this.#count = 1;
      return true;
    }
    if (this.#current.greaterThan(rect)) {
      // Before Current.
      for (;;) {
        const cur: RegionRect = this.#current!;
        if (cur === this.#head) {
          const head = this.#head;
          if (head.top === rect.top && head.bottom === rect.bottom && head.left === rect.right) {
            head.left = rect.left;
          } else {
            const n = new RegionRect(rect.left, rect.top, rect.right, rect.bottom);
            n.linkBefore(head);
            this.#count++;
            this.#head = n;
          }
          break;
        }
        const prev: RegionRect = cur.prev;
        if (prev.lessThan(rect)) {
          if (cur.top === rect.top && cur.bottom === rect.bottom && cur.left === rect.right) {
            cur.left = rect.left;
          } else {
            const n = new RegionRect(rect.left, rect.top, rect.right, rect.bottom);
            n.linkBefore(cur);
            this.#count++;
          }
          break;
        }
        this.#current = prev;
      }
    } else {
      // After Current.
      for (;;) {
        const cur: RegionRect = this.#current!;
        const next: RegionRect = cur.next;
        if (next === this.#head) {
          if (cur.top === rect.top && cur.bottom === rect.bottom && cur.right === rect.left) {
            cur.right = rect.right;
          } else {
            const n = new RegionRect(rect.left, rect.top, rect.right, rect.bottom);
            n.linkBefore(this.#head);
            this.#count++;
          }
          break;
        }
        if (next.greaterThan(rect)) {
          if (next.top === rect.top && next.bottom === rect.bottom && next.left === rect.right) {
            next.left = rect.left;
            if (cur.top === rect.top && cur.bottom === rect.bottom && cur.right === rect.left) {
              next.left = cur.left;
              this.#remove(cur);
            }
          } else {
            const n = new RegionRect(rect.left, rect.top, rect.right, rect.bottom);
            n.linkBefore(next);
            this.#count++;
          }
          break;
        }
        this.#current = next;
      }
    }
    return true;
  }

  /** `Remove`: no bound update. */
  #remove(rect: RegionRect): void {
    if (rect === this.#head) this.#head = rect.next;
    this.#count--;
    if (!this.#count) this.#current = this.#head = null;
    else if (rect === this.#current) this.#current = rect.prev;
    rect.unlink();
  }

  /** `Merge`: a complex rectangle that does not overlap this one. */
  #merge(rects: TvpComplexRect): void {
    rects.#ensureBound();
    this.#ensureBound();
    if (this.#count) {
      if (rects.#count) this.#bound.doUnion(rects.#bound);
    } else {
      if (rects.#count) this.#bound.assign(rects.#bound);
      else return;
    }
    // `rects` may be this object only when it is empty, which returned above.
    for (const r of rects.rects()) this.#insert(r);
  }

  or(r: TvpRect | TvpComplexRect): void {
    if (r instanceof TvpComplexRect) {
      this.#orComplex(r);
      return;
    }
    if (r.isEmpty()) return;
    if (this.#count === 0) {
      if (this.#insert(r)) {
        this.#bound.assign(r);
        this.#boundValid = true;
      }
      return;
    }
    this.#ensureBound();
    if (!this.#bound.intersectsWithNoEmptyCheck(r)) {
      if (this.#insert(r)) this.#bound.doUnion(r);
      return;
    }
    this.#bound.doUnion(r);
    let c: RegionRect | null = this.#head;
    while (c && c.top < r.bottom) {
      if (r.includedInNoEmptyCheck(c)) return;
      let nextIsHead: boolean;
      if (c.intersectsWithNoEmptyCheck(r)) {
        const next: RegionRect = c.next;
        nextIsHead = next === this.#head;
        this.#current = c;
        this.#rectangleSub(c, r);
        c = nextIsHead ? this.#head : next;
      } else {
        c = c.next;
        nextIsHead = c === this.#head;
      }
      if (!this.#head || !c || nextIsHead) break;
    }
    this.#insert(r);
  }

  #orComplex(ref: TvpComplexRect): void {
    if (ref.#count === 0) return;
    this.#ensureBound();
    ref.#ensureBound();
    if (!this.#bound.intersectsWithNoEmptyCheck(ref.#bound)) {
      this.#merge(ref);
      return;
    }
    for (const r of ref.rects()) this.or(r);
  }

  sub(r: TvpRect | TvpComplexRect): void {
    if (r instanceof TvpComplexRect) {
      this.#subComplex(r);
      return;
    }
    if (r.left >= r.right || r.top >= r.bottom) return;
    this.#ensureBound();
    if (!this.#bound.intersectsWithNoEmptyCheck(r)) return;
    // Natively an empty set with a bound across the origin reaches the walk below with no head.
    if (!this.#head) return;
    switch (intersectionCode(this.#bound, r)) {
      case 8 + 4 + 2 + 1:
        this.clear();
        return;
      case 8 + 4 + 2:
        this.#bound.top = r.bottom;
        break;
      case 4 + 2 + 1:
        this.#bound.right = r.left;
        break;
      case 8 + 4 + 1:
        this.#bound.bottom = r.top;
        break;
      case 8 + 2 + 1:
        this.#bound.left = r.right;
        break;
    }
    let c: RegionRect | null = this.#head;
    while (c && c.top < r.bottom) {
      let nextIsHead: boolean;
      if (c.intersectsWithNoEmptyCheck(r)) {
        const b = this.#bound;
        // `right == Bound.top` as natively.
        if (c.left === b.left || c.top === b.top || c.right === b.top || c.bottom === b.bottom)
          this.#boundValid = false;
        const next: RegionRect = c.next;
        nextIsHead = next === this.#head;
        this.#current = c;
        this.#rectangleSub(c, r);
        c = nextIsHead ? this.#head : next;
      } else {
        c = c.next;
        nextIsHead = c === this.#head;
      }
      if (!this.#head || !c || nextIsHead) break;
    }
  }

  #subComplex(ref: TvpComplexRect): void {
    if (ref.#count === 0) return;
    this.#ensureBound();
    ref.#ensureBound();
    if (!this.#bound.intersectsWithNoEmptyCheck(ref.#bound)) return;
    let boundValid = true;
    for (const r of ref.rects()) {
      this.sub(r);
      boundValid = this.#boundValid && boundValid;
      this.#boundValid = true;
    }
    this.#boundValid = boundValid;
  }

  and(r: TvpRect): void {
    if (this.#count === 0) return;
    if (r.left >= r.right || r.top >= r.bottom) {
      this.clear();
      return;
    }
    this.#ensureBound();
    if (!this.#bound.intersectsWithNoEmptyCheck(r)) {
      this.clear();
      return;
    }
    if (intersectionCode(this.#bound, r) === 8 + 4 + 2 + 1) return;
    let isFirst = true;
    let c: RegionRect = this.#head!;
    for (;;) {
      const cc = c;
      c = cc.next;
      const nextIsHead = c === this.#head;
      if (cc.clip(r)) {
        if (isFirst) {
          this.#bound.assign(cc);
          isFirst = false;
        } else this.#bound.doUnion(cc);
      } else {
        this.#remove(cc);
      }
      if (nextIsHead || !this.#head) break;
    }
    this.#boundValid = !isFirst;
  }

  /**
   * `CopyWithOffsets`: adds `ref` moved by the offsets and clipped by `clip`. Called right
   * after construction or `clear`, as natively.
   */
  copyWithOffsets(ref: TvpComplexRect, clip: TvpRect, ofsx: number, ofsy: number): void {
    if (!ref.#count) return;
    let isFirst = true;
    for (const src of ref.rects()) {
      const rect = src;
      rect.addOffsets(ofsx, ofsy);
      if (intersectRect(rect, rect, clip)) {
        this.#insert(rect);
        if (isFirst) {
          this.#bound.assign(rect);
          isFirst = false;
        } else this.#bound.doUnion(rect);
      }
    }
    this.#boundValid = !isFirst;
  }

  addOffsets(x: number, y: number): void {
    if (this.#count === 0) return;
    this.#bound.addOffsets(x, y);
    for (const r of this) r.addOffsets(x, y);
  }

  /** `RectangleSub`: subtracts `rr` from `r`, inserting the pieces that remain. */
  #rectangleSub(r: RegionRect, rr: TvpRect): void {
    const nr = new TvpRect();
    switch (intersectionCode(r, rr)) {
      case 0:
        this.#insert(nr.set(r.left, rr.top, rr.left, rr.bottom));
        this.#insert(nr.set(rr.right, rr.top, r.right, rr.bottom));
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.bottom = rr.top;
        break;
      case 8 + 4 + 2 + 1:
        this.#remove(r);
        break;
      case 8 + 4:
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.bottom = rr.top;
        break;
      case 1 + 2:
        this.#insert(nr.set(rr.right, r.top, r.right, r.bottom));
        r.right = rr.left;
        break;
      case 8 + 2:
        this.#insert(nr.set(rr.right, r.top, r.right, rr.bottom));
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        this.#remove(r);
        break;
      case 4 + 2:
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.bottom = rr.bottom;
        r.right = rr.left;
        break;
      case 4 + 1:
        this.#insert(nr.set(r.left, rr.top, rr.left, r.bottom));
        r.bottom = rr.top;
        break;
      case 8 + 1:
        this.#insert(nr.set(rr.right, rr.top, r.right, r.bottom));
        r.bottom = rr.top;
        break;
      case 8 + 4 + 2:
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        this.#remove(r);
        break;
      case 4 + 2 + 1:
        r.right = rr.left;
        break;
      case 8 + 4 + 1:
        r.bottom = rr.top;
        break;
      case 8 + 2 + 1:
        this.#insert(nr.set(rr.right, r.top, r.right, r.bottom));
        this.#remove(r);
        break;
      case 8:
        this.#insert(nr.set(rr.right, rr.top, r.right, rr.bottom));
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.bottom = rr.top;
        break;
      case 4:
        this.#insert(nr.set(r.left, rr.top, rr.left, rr.bottom));
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.bottom = rr.top;
        break;
      case 2:
        this.#insert(nr.set(rr.right, r.top, r.right, rr.bottom));
        this.#insert(nr.set(r.left, rr.bottom, r.right, r.bottom));
        r.right = rr.left;
        r.bottom = rr.bottom;
        break;
      case 1:
        this.#insert(nr.set(r.left, rr.top, rr.left, r.bottom));
        this.#insert(nr.set(rr.right, rr.top, r.right, r.bottom));
        r.bottom = rr.top;
        break;
    }
  }
}
