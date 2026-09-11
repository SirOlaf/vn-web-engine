/** Engine-specific access is separate from the expression reducer. */
export interface ExpressionHost {
  byte(): number;
  readVariable(index: number): number;
  writeVariable(index: number, value: number): void;
  readFlag(index: number): number;
  writeFlag(index: number, value: number): void;
  readContext(handle: number | undefined, index: number): number;
  writeContext(handle: number | undefined, index: number, value: number): void;
  readScript(slot: number | undefined, offset: number): number;
  inputPressed: number;
  inputHeld: number;
  random15(): number;
}

function arithmetic(op: number, a: number, b: number): number {
  a |= 0;
  b |= 0;
  switch (op) {
    case 1:
      return Math.imul(a, b);
    case 2:
    case 5:
      if (!b) return 0x7fffffff;
      if (a === -0x80000000 && b === -1) throw new Error('Native signed division overflow');
      return (op === 2 ? Math.trunc(a / b) : a % b) | 0;
    case 3:
      return (a + b) | 0;
    case 4:
      return (a - b) | 0;
    case 6:
      return a << b;
    case 7:
      return a >> b;
    case 8:
      return a & b;
    case 9:
      return a ^ b;
    case 10:
      return a | b;
    case 12:
      return +(a === b);
    case 13:
      return +(a !== b);
    case 14:
      return +(a <= b);
    case 15:
      return +(a >= b);
    case 16:
      return +(a < b);
    case 17:
      return +(a > b);
    default:
      throw new Error(`Unknown expression arithmetic 0x${op.toString(16)}`);
  }
}

/** 14001ea10 / 14001eef0. Keep all five words and stale tail entries: 31/32 observe them. */
export class Sc3Expressions {
  constructor(readonly scratch: Int32Array = new Int32Array(256 * 5)) {
    if (scratch.length !== 256 * 5) throw new Error('Expected 256 expression scratch entries');
  }
  private value(i: number): number {
    this.index(i);
    return this.scratch[i * 5]!;
  }
  private priority(i: number): number {
    this.index(i);
    return this.scratch[i * 5 + 1]!;
  }
  private op(i: number): number {
    this.index(i);
    return this.scratch[i * 5 + 2]!;
  }
  private index(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= 256) throw new Error('Expression scratch bounds');
  }
  private put(i: number, word: number, value: number): void {
    this.index(i);
    this.scratch[i * 5 + word] = value;
  }
  private move(destination: number, source: number, entries: number): void {
    if (entries > 0) this.scratch.copyWithin(destination * 5, source * 5, (source + entries) * 5);
  }
  private read(h: ExpressionHost, op: number, a: number, b: number): number {
    switch (op) {
      case 0xb:
        return ~a;
      case 0x28:
        return h.readVariable(a);
      case 0x29:
        return h.readFlag(a >>> 0);
      case 0x2a:
        return a < 0
          ? h.readContext(a, (Math.imul(b, 4) | 0) / 4)
          : h.readScript(undefined, a + Math.imul(b, 4));
      case 0x2b:
        return h.readScript(undefined, (Math.imul(a, 4) + 12) >>> 0);
      case 0x2c:
        return h.readScript(a >>> 0, (Math.imul(b, 4) + 12) >>> 0);
      case 0x2d:
        return h.readContext(undefined, a);
      case 0x2e:
        return a < 0 ? h.readContext(a, b) : 0;
      case 0x33:
        return (Math.imul(h.random15() & 0x7fff, a) >>> 0) >>> 15;
      default:
        throw new Error(`Unknown expression access 0x${op.toString(16)}`);
    }
  }
  private reduce(h: ExpressionHost, i: number, count: number): number {
    const op = this.op(i);
    if (op >= 1 && op <= 17 && op !== 11) {
      const result = arithmetic(op, this.value(i - 1), this.value(i + 1));
      count -= 2;
      this.put(i - 1, 0, result);
      this.move(i, i + 2, count - i);
      return count;
    }
    if ([11, 0x28, 0x29, 0x2b, 0x2d, 0x33].includes(op)) {
      const result = this.read(h, op, this.value(i + 1), 0);
      count--;
      this.put(i, 0, result);
      this.put(i, 1, 0);
      this.put(i, 2, 0xff);
      this.move(i + 1, i + 2, count - i - 1);
      return count;
    }
    if ([0x2a, 0x2c, 0x2e].includes(op)) {
      const result = this.read(h, op, this.value(i + 1), this.value(i + 2));
      count -= 2;
      this.put(i, 0, result);
      this.put(i, 2, 0xff); // Native retains priority here.
      this.move(i + 1, i + 3, count - i - 1);
      return count;
    }
    if (op >= 0x14 && op <= 0x21) {
      const lhs = this.op(0),
        a = this.value(1),
        b = this.value(2),
        rhs = this.value(i + 1);
      // Even plain assignment reads its destination. 2a reads but cannot write.
      let result = [0x28, 0x29, 0x2a, 0x2d, 0x2e].includes(lhs) ? this.read(h, lhs, a, b) : 0;
      if (op === 0x14) result = rhs;
      else if (op <= 0x1e)
        result = arithmetic([1, 2, 3, 4, 5, 6, 7, 8, 10, 9][op - 0x15]!, result, rhs);
      else if (op === 0x20) result = (result + 1) | 0;
      else if (op === 0x21) result = (result - 1) | 0;
      // 1f leaves the destination value alone but still performs these writes.
      if (lhs === 0x28) h.writeVariable(a, result);
      else if (lhs === 0x29) h.writeFlag(a >>> 0, result);
      else if (lhs === 0x2d) h.writeContext(undefined, a, result);
      else if (lhs === 0x2e && a < 0) h.writeContext(a, b, result);
      h.writeContext(undefined, 7, result);
      return count;
    }
    throw new Error(`Unresolved expression operator 0x${op.toString(16)}`);
  }
  private highest(start: number, end: number): number {
    let priority = 0;
    for (let i = start; i < end; i++)
      if (this.op(i) !== 0xff) priority = Math.max(priority, this.priority(i));
    return priority;
  }
  evaluate(h: ExpressionHost): number {
    let count = 0;
    this.put(0, 2, 0);
    // Capture input once, matching the native parser's entry snapshots.
    const pressed = h.inputPressed,
      held = h.inputHeld;
    for (let tag = h.byte(); tag !== 0; tag = h.byte()) {
      if (count >= 255) throw new Error('Expression token limit');
      if (tag & 0x80) {
        let value: number;
        switch (tag & 0x60) {
          case 0:
            value = ((tag & 31) << 27) >> 27;
            break;
          case 0x20:
            value = (((tag & 31) * 256 + h.byte()) << 19) >> 19;
            break;
          case 0x40: {
            const lo = h.byte(),
              hi = h.byte();
            value = (((tag & 31) * 65536 + hi * 256 + lo) << 11) >> 11;
            break;
          }
          default:
            value = h.byte() | (h.byte() << 8) | (h.byte() << 16) | (h.byte() << 24);
        }
        h.byte(); // Extra byte is consumed, not an expression terminator.
        this.put(count, 0, value);
        this.put(count, 1, 0);
        this.put(count, 2, 0xff);
      } else {
        this.put(count, 1, h.byte());
        this.put(count, 2, tag);
        if (tag >= 0x2f && tag <= 0x32) {
          this.put(count, 1, 0);
          this.put(count, 2, 0xff);
          if (tag === 0x2f) this.put(count, 0, pressed);
          else if (tag === 0x30) this.put(count, 0, held);
        }
      }
      this.put(++count, 2, 0);
    }
    let assignment = 0;
    while (assignment < count && !(this.op(assignment) >= 0x14 && this.op(assignment) <= 0x21))
      assignment++;
    if (assignment === count) {
      while (count >= 2) {
        const before = count,
          priority = this.highest(0, count);
        if (!priority) throw new Error('Expression did not reduce to a value');
        for (let i = 0; i < count; i++)
          if (this.priority(i) === priority) count = this.reduce(h, i, count);
        if (count === before) throw new Error('Expression reduction made no progress');
      }
      return this.value(0);
    }
    const rhsStart = assignment + 1;
    while (rhsStart < count) {
      const before = count,
        priority = this.highest(rhsStart, count);
      if (!priority) break;
      for (let i = rhsStart; i < count; i++)
        if (this.priority(i) === priority) count = this.reduce(h, i, count);
      if (count === before || count <= rhsStart) break;
    }
    const rhs = this.value(rhsStart);
    this.put(rhsStart, 2, 0);
    while (count > 1 && assignment > 1) {
      const before = count,
        priority = this.highest(1, assignment);
      if (!priority) break;
      for (let i = 1; i < assignment; i++)
        if (this.priority(i) === priority) count = this.reduce(h, i, count);
      if (count === before || count < 2) break;
    }
    let end = 0;
    while (this.op(end) !== 0) end++;
    let at = 0;
    while (at <= end && !(this.op(at) >= 0x14 && this.op(at) <= 0x21)) at++;
    this.put(at + 1, 0, rhs);
    this.put(at + 1, 2, 0xff);
    this.reduce(h, at, count);
    return rhs;
  }
}
