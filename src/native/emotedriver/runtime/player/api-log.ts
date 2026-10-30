/** Native x64 API log (+0x348..+0x390), exact DLL 80d28bd0…1e051. */
const formats = {
  CalcLayerFrameInfo: 'f',
  Skip: '',
  Step: '',
  Pass: '',
  SetVariable: 'sfff',
  SetVariableDiff: 'ssfff',
  SetCoord: 'ffff',
  SetScale: 'fff',
  SetRot: 'fff',
  SetColor: 'dff',
  SetGrayscale: 'fff',
  SetOuterForce: 'sffff',
  SetOuterRot: 'fff',
  PlayTimeline: 'sd',
  StopTimeline: 's',
  SetTimelineBlendRatio: 'sfffd',
  FadeInTimeline: 'sff',
  FadeOutTimeline: 'sff',
} as const;
type Operation = keyof typeof formats;
// C strings retain a leading UTF8 BOM as label data rather than a file marker.
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', {ignoreBOM: true});
const bits = new DataView(new ArrayBuffer(4));
const cString = (value: string): string => value.split('\0', 1)[0]!;

/** Six fixed decimals after float32 promotion; the DLL's CRT initializer selects ties-even. */
function fixed(value: number): string {
  bits.setFloat32(0, value, true);
  const word = bits.getUint32(0, true),
    negative = word >>> 31 !== 0,
    exponent = (word >>> 23) & 255,
    fraction = word & 0x7fffff,
    sign = negative ? '-' : '';
  if (exponent === 255)
    return sign + (fraction === 0 ? 'inf' : negative && fraction === 0x400000 ? 'nan(ind)' : 'nan');
  let numerator = BigInt(fraction | (exponent ? 0x800000 : 0)) * 1000000n;
  const shift = (exponent || 1) - 150;
  let rounded: bigint;
  if (shift >= 0) rounded = numerator << BigInt(shift);
  else {
    const denominator = 1n << BigInt(-shift);
    rounded = numerator / denominator;
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded & 1n)) rounded++;
  }
  const digits = rounded.toString().padStart(7, '0');
  return sign + digits.slice(0, -6) + '.' + digits.slice(-6);
}

/** Round a nonnegative rational directly to binary32, avoiding decimal→binary64 double rounding. */
function rational(numerator: bigint, denominator: bigint, negative: boolean): number {
  const sign = negative ? 0x80000000 : 0;
  if (numerator === 0n) {
    bits.setUint32(0, sign, true);
    return bits.getFloat32(0, true);
  }
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (
    exponent >= 0
      ? numerator < denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) < denominator
  )
    exponent--;
  if (exponent > 127) return negative ? -Infinity : Infinity;
  const shift = Math.max(-149, exponent - 23);
  if (shift < 0) numerator <<= BigInt(-shift);
  else denominator <<= BigInt(shift);
  let mantissa = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && mantissa & 1n)) mantissa++;
  if (mantissa === 0x1000000n) {
    mantissa >>= 1n;
    exponent++;
  }
  const word =
    exponent > 127
      ? 0x7f800000
      : mantissa < 0x800000n
        ? Number(mantissa)
        : ((Math.max(exponent, -126) + 127) << 23) | (Number(mantissa) & 0x7fffff);
  bits.setUint32(0, (sign | word) >>> 0, true);
  return bits.getFloat32(0, true);
}

function floatOf(token: string): number {
  const negative = token[0] === '-';
  let value = token.replace(/^[+-]/, '').toLowerCase();
  if (value.startsWith('inf')) return negative ? -Infinity : Infinity;
  if (value.startsWith('nan')) {
    bits.setUint32(0, negative ? 0xffc00000 : 0x7fc00000, true);
    return bits.getFloat32(0, true);
  }
  const hex = value.startsWith('0x'),
    parts = value.split(hex ? 'p' : 'e'),
    point = parts[0]!.indexOf('.'),
    fractional = point < 0 ? 0 : parts[0]!.length - point - 1;
  let digits = parts[0]!.replace('.', '').replace(/^0x/, '').replace(/^0+/, ''),
    power = Number(parts[1] ?? 0) - fractional * (hex ? 4 : 1);
  if (!digits) return negative ? -0 : 0;
  // Native conversion retains a bounded significant prefix. A sticky final digit
  // distinguishes an exact halfway value from any nonzero discarded suffix.
  if (digits.length > 768) {
    const suffix = digits.slice(768);
    power += (digits.length - 769) * (hex ? 4 : 1);
    digits = digits.slice(0, 768) + (/[1-9a-f]/.test(suffix) ? '1' : '0');
  }
  const order = (hex ? digits.length * 4 : digits.length) + power;
  if (order > (hex ? 160 : 50)) return negative ? -Infinity : Infinity;
  if (order < (hex ? -180 : -60)) return negative ? -0 : 0;
  const numerator = BigInt((hex ? '0x' : '') + digits),
    base = hex ? 2n : 10n;
  return power >= 0
    ? rational(numerator * base ** BigInt(power), 1n, negative)
    : rational(numerator, base ** BigInt(-power), negative);
}

/** The log's scanf fields use C-locale whitespace, byte-limited strings and numeric prefixes. */
class Fields {
  private at = 0;
  private readonly bytes: Uint8Array;
  constructor(line: string) {
    this.bytes = encoder.encode(cString(line));
  }
  private space(): void {
    while (this.at < this.bytes.length && [9, 10, 11, 12, 13, 32].includes(this.bytes[this.at]!))
      this.at++;
  }
  string(limit = 255): string | null {
    this.space();
    const start = this.at;
    while (
      this.at < this.bytes.length &&
      this.at - start < limit &&
      ![9, 10, 11, 12, 13, 32].includes(this.bytes[this.at]!)
    )
      this.at++;
    return this.at === start ? null : decoder.decode(this.bytes.subarray(start, this.at));
  }
  number(integer: boolean): number | null {
    this.space();
    const tail = decoder.decode(this.bytes.subarray(this.at));
    const match = integer
      ? /^[+-]?\d+/.exec(tail)
      : /^[+-]?(?:inf(?:inity)?|nan(?:\([^)]*\))?|0x(?:[\da-f]+\.?[\da-f]*|\.[\da-f]+)(?:p[+-]?\d*)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d*)?)/i.exec(
          tail,
        );
    if (
      !match ||
      (!integer && (/^[+-]?0x/i.test(match[0]) ? /p[+-]?$/i : /e[+-]?$/i).test(match[0]))
    )
      return null;
    this.at += match[0].length;
    return integer ? Number(BigInt(match[0]) & 0xffffffffn) | 0 : floatOf(match[0]);
  }
}

export interface EmoteApiLogHost {
  setVariable(label: string, value: number, frames: number, easing: number): void;
  setVariableDiff(
    module: string,
    label: string,
    value: number,
    frames: number,
    easing: number,
  ): void;
  setCoord(x: number, y: number, frames: number, easing: number): void;
  setScale(value: number, frames: number, easing: number): void;
  setRot(value: number, frames: number, easing: number): void;
  setColor(value: number, frames: number, easing: number): void;
  setGrayscale(value: number, frames: number, easing: number): void;
  setOuterForce(label: string, x: number, y: number, frames: number, easing: number): void;
  setOuterRot(value: number, frames: number, easing: number): void;
  playTimeline(label: string, flags: number): void;
  stopTimeline(label: string): void;
  setTimelineBlendRatio(
    label: string,
    value: number,
    frames: number,
    easing: number,
    stop: boolean,
  ): void;
  fadeInTimeline(label: string, frames: number, easing: number): void;
  fadeOutTimeline(label: string, frames: number, easing: number): void;
  skip(): void;
  step(): void;
  pass(): void;
}

export interface EmoteApiLogScope {
  enter(): boolean;
  leave(): void;
  record(operation: Operation, args: readonly (number | string | boolean)[]): void;
}

export class EmoteApiLog implements EmoteApiLogScope {
  private mode = 0;
  private depth = 0;
  private lines: string[] = [];
  private cursor = 0;
  private frame = 1;

  /** Native scope counter suppresses only nested record entries, not execution. */
  enter(): boolean {
    return ++this.depth === 1 && this.mode === 1;
  }
  leave(): void {
    this.depth--;
  }
  record(operation: Operation, args: readonly (number | string | boolean)[]): void {
    const fields = formats[operation];
    const parts: string[] = [];
    let length = operation.length + 1;
    for (let i = 0; i < fields.length; i++) {
      const kind = fields[i],
        text =
          kind === 's'
            ? cString(String(args[i]))
            : kind === 'd'
              ? String(Number(args[i]) | 0)
              : fixed(Number(args[i]));
      if (i) length++;
      // UTF8 cannot be shorter than its input's UTF16 code-unit count. Reject
      // oversized fields before allocating an unbounded encoded temporary.
      if (length + text.length >= 1024 || (length += encoder.encode(text).length) >= 1024) {
        this.lines.push('BufferOverflow');
        return;
      }
      parts.push(text);
    }
    this.lines.push(operation + ' ' + parts.join(' '));
  }
  startRecord(): void {
    this.mode = 1;
  }
  stop(): void {
    this.mode = 0;
  }
  get recording(): boolean {
    return this.mode === 1;
  }
  get replaying(): boolean {
    return this.mode === 2;
  }
  startReplay(): void {
    this.mode = 2;
    this.cursor = 0;
    this.frame = 1;
  }
  clear(): void {
    this.lines = [];
    this.mode = 0;
  }
  get(): string {
    return this.lines.map((line) => line + '\r\n').join('');
  }
  set(log: string): void {
    const text = cString(log);
    this.lines = text.split(/[\r\n]+/);
    if (/[\r\n]$/.test(text)) this.lines.pop();
    this.mode = 0;
  }

  /** 0x1800205e0: execute through the next valid frame marker, or stop at end. */
  replay(host: EmoteApiLogHost, frames: number): number {
    if (this.mode !== 2) return frames;
    while (this.cursor < this.lines.length) {
      const fields = new Fields(this.lines[this.cursor++]!),
        operation = fields.string();
      if (!operation || !Object.hasOwn(formats, operation)) continue;
      const args: (number | string)[] = [];
      let valid = true;
      for (const kind of formats[operation as Operation]) {
        const value = kind === 's' ? fields.string() : fields.number(kind === 'd');
        if (value === null) {
          valid = false;
          break;
        }
        args.push(value);
      }
      if (!valid) continue;
      const n = (i: number): number => args[i] as number,
        s = (i: number): string => args[i] as string;
      switch (operation as Operation) {
        case 'CalcLayerFrameInfo':
          this.frame = n(0);
          return this.frame;
        case 'Skip':
          host.skip();
          break;
        case 'Step':
          host.step();
          break;
        case 'Pass':
          host.pass();
          break;
        case 'SetVariable':
          host.setVariable(s(0), n(1), n(2), n(3));
          break;
        case 'SetVariableDiff':
          host.setVariableDiff(s(0), s(1), n(2), n(3), n(4));
          break;
        case 'SetCoord':
          host.setCoord(n(0), n(1), n(2), n(3));
          break;
        case 'SetScale':
          host.setScale(n(0), n(1), n(2));
          break;
        case 'SetRot':
          host.setRot(n(0), n(1), n(2));
          break;
        case 'SetColor':
          host.setColor(n(0), n(1), n(2));
          break;
        case 'SetGrayscale':
          host.setGrayscale(n(0), n(1), n(2));
          break;
        case 'SetOuterForce':
          host.setOuterForce(s(0), n(1), n(2), n(3), n(4));
          break;
        case 'SetOuterRot':
          host.setOuterRot(n(0), n(1), n(2));
          break;
        case 'PlayTimeline':
          host.playTimeline(s(0), n(1));
          break;
        case 'StopTimeline':
          host.stopTimeline(s(0));
          break;
        case 'SetTimelineBlendRatio':
          host.setTimelineBlendRatio(s(0), n(1), n(2), n(3), n(4) !== 0);
          break;
        case 'FadeInTimeline':
          host.fadeInTimeline(s(0), n(1), n(2));
          break;
        case 'FadeOutTimeline':
          host.fadeOutTimeline(s(0), n(1), n(2));
          break;
      }
    }
    this.mode = 0;
    return frames;
  }
}
