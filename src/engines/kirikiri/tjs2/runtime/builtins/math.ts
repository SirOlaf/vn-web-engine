/**
 * `Math` and `Math.RandomGenerator` (krkrz `tjsMath.cpp`, `tjsRandomGenerator.cpp`,
 * `tjsMT19937ar-cok.cpp`). All `Math` members are static.
 *
 * The reference build predates the xorshift `Math.random` of later krkrz: its constructor
 * calls `srand(time())` and `random` returns `rand() / 32767.0` (0x4c30e0), so the result can
 * be 1.0. `rand` is the CRT's (`MsvcRand`).
 */
import {throwTjsError, TjsError} from '../errors.js';
import {
  failed,
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_MEMBERENSURE,
  TJS_MEMBERMUSTEXIST,
  TJS_S_OK,
} from '../interface.js';
import {closurePropGet} from '../dispatch.js';
import {constructNativeInstance, NativeClass, NativeInstanceBase} from '../native.js';
import {VariantSlot} from '../slot.js';
import type {Dispatch} from '../interface.js';
import {
  asInt32,
  asInteger,
  asObjectClosure,
  asReal,
  asString,
  int,
  integer,
  obj,
  real,
  str,
  type Variant,
} from '../variant.js';
import type {TjsEngine} from '../engine.js';

/** The CRT `rand`/`srand` of the reference build: an LCG returning 15 bits. */
export class MsvcRand {
  #holdrand = 1;
  srand(seed: number): void {
    this.#holdrand = seed >>> 0;
  }
  rand(): number {
    this.#holdrand = (Math.imul(this.#holdrand, 214013) + 2531011) >>> 0;
    return (this.#holdrand >>> 16) & 0x7fff;
  }
}

const MT_N = 624;
const MT_M = 397;

function twist(u: number, v: number): number {
  return (((u & 0x80000000) | (v & 0x7fffffff)) >>> 1) ^ (v & 1 ? 0x9908b0df : 0);
}

/** `tTJSMersenneTwister`. `next` is an index into `state`. */
export class MersenneTwister {
  readonly state = new Uint32Array(MT_N);
  left = 1;
  next = 0;

  static fromSeed(s: number): MersenneTwister {
    const mt = new MersenneTwister();
    mt.#initGenrand(s);
    return mt;
  }

  static fromKey(key: readonly number[]): MersenneTwister {
    const mt = new MersenneTwister();
    const st = mt.state;
    mt.#initGenrand(19650218);
    let i = 1,
      j = 0;
    for (let k = MT_N > key.length ? MT_N : key.length; k; k--) {
      const p = st[i - 1]! ^ (st[i - 1]! >>> 30);
      st[i] = ((st[i]! ^ Math.imul(p, 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= MT_N) {
        st[0] = st[MT_N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = MT_N - 1; k; k--) {
      const p = st[i - 1]! ^ (st[i - 1]! >>> 30);
      st[i] = ((st[i]! ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i++;
      if (i >= MT_N) {
        st[0] = st[MT_N - 1]!;
        i = 1;
      }
    }
    st[0] = 0x80000000;
    mt.left = 1;
    mt.next = 0;
    return mt;
  }

  #initGenrand(s: number): void {
    const st = this.state;
    st[0] = s >>> 0;
    for (let j = 1; j < MT_N; j++) {
      const p = st[j - 1]! ^ (st[j - 1]! >>> 30);
      st[j] = (Math.imul(1812433253, p) + j) >>> 0;
    }
    this.left = 1;
    this.next = 0;
  }

  #nextState(): void {
    const st = this.state;
    this.left = MT_N;
    this.next = 0;
    let p = 0;
    for (let j = MT_N - MT_M + 1; --j; p++) st[p] = st[p + MT_M]! ^ twist(st[p]!, st[p + 1]!);
    for (let j = MT_M; --j; p++) st[p] = st[p + MT_M - MT_N]! ^ twist(st[p]!, st[p + 1]!);
    st[p] = st[p + MT_M - MT_N]! ^ twist(st[p]!, st[0]!);
  }

  int32(): number {
    if (--this.left === 0) this.#nextState();
    let y = this.state[this.next++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `rand_double`: 52 random significand bits of a double in [1, 2), minus 1. */
  randDouble(): number {
    const lo = this.int32();
    const hi = this.int32() & 0x000fffff;
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, hi | 0x3ff00000);
    view.setUint32(4, lo);
    return view.getFloat64(0) - 1.0;
  }
}

/** `tTJSNI_RandomGenerator`. */
class RandomGeneratorNI extends NativeInstanceBase {
  generator: MersenneTwister | null = null;

  constructor(private readonly engine: TjsEngine) {
    super();
  }

  /** `Randomize`: entropy, a serialized state dictionary, or an integer seed. */
  randomize(args: readonly Variant[]): void {
    if (args.length === 0) {
      const bits = this.engine.host.randomBits128?.bind(this.engine.host);
      if (bits) {
        const buf = new Uint8Array(32);
        buf.set(bits(), 0);
        buf.set(bits(), 16);
        const tmp: number[] = [];
        // As natively, byte 1 (not byte i) supplies bits 16..23.
        for (let i = 0; i < 32; i++)
          tmp.push((buf[i]! + (buf[i]! << 8) + (buf[1]! << 16) + (buf[i]! << 24)) >>> 0);
        this.generator = MersenneTwister.fromKey(tmp);
      } else this.generator = MersenneTwister.fromSeed(this.engine.host.time());
      return;
    }
    const p = args[0]!;
    if (p.type === 1) {
      try {
        const clo = asObjectClosure(p);
        if (!clo.object) throwTjsError('TJSNullAccess');
        const val = new VariantSlot();
        const read = (name: string) => {
          if (failed(closurePropGet(clo, TJS_MEMBERMUSTEXIST, name, val, null)))
            throwTjsError('TJSNotReconstructiveRandomizeData');
          return val.value;
        };
        const state = asString(read('state'));
        if (state.length !== MT_N * 8) throwTjsError('TJSNotReconstructiveRandomizeData');
        const mt = new MersenneTwister();
        for (let i = 0; i < MT_N; i++) {
          const hex = state.slice(i * 8, i * 8 + 8);
          if (!/^[0-9A-Fa-f]{8}$/.test(hex)) throwTjsError('TJSNotReconstructiveRandomizeData');
          mt.state[i] = parseInt(hex, 16);
        }
        mt.left = asInt32(read('left'));
        mt.next = asInt32(read('next'));
        val.clear();
        this.generator = mt;
      } catch (e) {
        if (e instanceof TjsError) throwTjsError('TJSNotReconstructiveRandomizeData');
        throw e;
      }
      return;
    }
    const n = BigInt.asUintN(64, asInteger(p));
    this.generator = MersenneTwister.fromKey([Number(n & 0xffffffffn), Number(n >> 32n)]);
  }
}

const SQRT1_2 = 0.7071067811865476;

export class MathClass extends NativeClass {
  constructor(engine: TjsEngine) {
    super('Math');
    engine.crtRand.srand(engine.host.time());
    this.emptyFinalize();
    this.constructorMethod(() => TJS_S_OK);
    const unary = (name: string, f: (x: number) => number) =>
      this.staticMethod(name, (result, args) => {
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        result?.set(real(f(asReal(args[0]!))));
        return TJS_S_OK;
      });
    unary('abs', Math.abs);
    unary('acos', Math.acos);
    unary('asin', Math.asin);
    unary('atan', Math.atan);
    this.staticMethod('atan2', (result, args) => {
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      result?.set(real(Math.atan2(asReal(args[0]!), asReal(args[1]!))));
      return TJS_S_OK;
    });
    unary('ceil', Math.ceil);
    unary('exp', Math.exp);
    unary('floor', Math.floor);
    unary('log', Math.log);
    this.staticMethod('pow', (result, args) => {
      if (args.length < 2) return TJS_E_BADPARAMCOUNT;
      result?.set(real(Math.pow(asReal(args[0]!), asReal(args[1]!))));
      return TJS_S_OK;
    });
    this.staticMethod('max', (result, args) => {
      if (!result) return TJS_S_OK;
      let r = -Infinity;
      for (const a of args) {
        const v = asReal(a);
        if (Number.isNaN(v)) return (result.set(real(NaN)), TJS_S_OK);
        if (Object.is(v, 0)) {
          if (r < 0 || Object.is(r, -0)) r = v;
        } else if (r < v) r = v;
      }
      result.set(real(r));
      return TJS_S_OK;
    });
    this.staticMethod('min', (result, args) => {
      if (!result) return TJS_S_OK;
      let r = Infinity;
      for (const a of args) {
        const v = asReal(a);
        if (Number.isNaN(v)) return (result.set(real(NaN)), TJS_S_OK);
        if (Object.is(v, -0)) {
          if (!(r < 0 || Object.is(r, -0))) r = v;
        } else if (v < r) r = v;
      }
      result.set(real(r));
      return TJS_S_OK;
    });
    this.staticMethod('random', (result) => {
      if (result) result.set(real(engine.crtRand.rand() / 32767.0));
      return TJS_S_OK;
    });
    unary('round', (x) => Math.floor(x + 0.5));
    unary('sin', Math.sin);
    unary('cos', Math.cos);
    unary('sqrt', Math.sqrt);
    unary('tan', Math.tan);
    const constant = (name: string, value: number) =>
      this.staticProperty(name, {get: (result) => (result.set(real(value)), TJS_S_OK)});
    constant('E', Math.E);
    constant('LOG2E', Math.LOG2E);
    constant('LOG10E', Math.LOG10E);
    constant('LN10', Math.LN10);
    constant('LN2', Math.LN2);
    constant('PI', Math.PI);
    constant('SQRT1_2', SQRT1_2);
    constant('SQRT2', Math.SQRT2);
  }
}

export class RandomGeneratorClass extends NativeClass {
  constructor(engine: TjsEngine) {
    super('RandomGenerator', () => new RandomGeneratorNI(engine));
    const self = this;
    const get = (objthis: Dispatch) => self.instanceOf<RandomGeneratorNI>(objthis);
    this.emptyFinalize();
    this.constructorMethod((_result, args, objthis) => {
      const r = constructNativeInstance<RandomGeneratorNI>(self, args, objthis);
      if (typeof r === 'number') return r;
      r.randomize(args);
      return TJS_S_OK;
    });
    this.method('randomize', (_result, args, objthis) => {
      const r = get(objthis);
      if (!r) return TJS_E_NATIVECLASSCRASH;
      r.randomize(args);
      return TJS_S_OK;
    });
    this.method('random', (result, _args, objthis) => {
      const r = get(objthis);
      if (!r) return TJS_E_NATIVECLASSCRASH;
      const v = r.generator ? r.generator.randDouble() : 0;
      result?.set(real(v));
      return TJS_S_OK;
    });
    this.method('random32', (result, _args, objthis) => {
      const r = get(objthis);
      if (!r) return TJS_E_NATIVECLASSCRASH;
      const v = r.generator ? r.generator.int32() : 0;
      result?.set(integer(BigInt(v)));
      return TJS_S_OK;
    });
    const random64 =
      (mask: bigint) =>
      (result: VariantSlot | null, _args: readonly Variant[], objthis: Dispatch) => {
        const r = get(objthis);
        if (!r) return TJS_E_NATIVECLASSCRASH;
        let v = 0n;
        if (r.generator) {
          const lo = BigInt(r.generator.int32());
          const hi = BigInt(r.generator.int32());
          v = ((hi << 32n) | lo) & mask;
        }
        result?.set(integer(v));
        return TJS_S_OK;
      };
    this.method('random63', random64(0x7fffffffffffffffn));
    this.method('random64', random64(0xffffffffffffffffn));
    this.method('serialize', (result, _args, objthis) => {
      const r = get(objthis);
      if (!r) return TJS_E_NATIVECLASSCRASH;
      if (!result) return TJS_S_OK;
      const g = r.generator;
      if (!g) {
        // Serialize returns null natively and the result dereferences it.
        throwTjsError('TJSNullAccess');
      }
      let state = '';
      for (let i = 0; i < MT_N; i++) state += g.state[i]!.toString(16).padStart(8, '0');
      const dic = engine.createDictionary();
      dic.propSet(TJS_MEMBERENSURE, 'state', str(state), dic);
      dic.propSet(TJS_MEMBERENSURE, 'left', int(g.left), dic);
      dic.propSet(TJS_MEMBERENSURE, 'next', int(g.next), dic);
      result.set(obj(dic, dic));
      dic.release();
      return TJS_S_OK;
    });
  }
}
