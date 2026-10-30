import type {EmoteMeshCombinator} from '../../../../formats/kirikiri/emote-model.js';
import {emoteBuild, EMOTEDRIVER_X64_SHA256} from '../../build.js';
import {EmoteUnsupportedError} from '../errors.js';
import type {EmoteCombinatorTarget, EmoteCombinatorVariables} from '../interfaces.js';
import {expandEmoteVariableBounds} from '../player/stereovision.js';

/** X64 mesh-combinator registry (0x180058c50 / 0x180059e80). */
const f32 = Math.fround;
const FLT_EPSILON = f32(2 ** -23);

interface Combinator {
  readonly def: {readonly raw: Float32Array; readonly neutralIndex: number};
  cur: Float32Array;
  prev: Float32Array;
  changed: boolean;
  neutral: boolean;
}

interface CombinatorVariable {
  readonly key: string;
  readonly meshType: number;
  readonly rangeBegin: number;
  readonly rangeEnd: number;
  readonly meshCount: number;
  f: number;
  readonly members: Combinator[];
}

interface CombinatorLayer {
  readonly target: EmoteCombinatorTarget;
  readonly owner: object;
  readonly meshType: number;
  readonly combinators: Combinator[];
  readonly sum: Float32Array;
}

function combinatorF(v: CombinatorVariable, value: number): number {
  let x = f32((value - v.rangeBegin) / (v.rangeEnd - v.rangeBegin));
  if (x >= 1) x = 1;
  if (x <= 0) x = 0;
  return f32(x * (v.meshCount - 1));
}

function evalCombinator(c: Combinator, f: number): void {
  const i = Math.trunc(f);
  const frac = f32(f - i);
  const raw = c.def.raw;
  const o0 = i * 32,
    o1 = i * 32 + 32;
  if (Math.abs(frac) >= FLT_EPSILON) {
    const ie = f32(1 - frac);
    for (let k = 0; k < 32; k++) c.cur[k] = raw[o0 + k]! * ie + raw[o1 + k]! * frac;
  } else c.cur.set(raw.subarray(o0, o0 + 32));
  c.neutral = c.def.neutralIndex === i && Math.abs(frac) < FLT_EPSILON;
}

export class EmoteMeshCombinators {
  private readonly variables = new Map<string, CombinatorVariable[]>();
  private readonly layers: CombinatorLayer[] = [];

  constructor(
    private readonly variablesSource: EmoteCombinatorVariables,
    driverSha256: string,
  ) {
    if (emoteBuild(driverSha256) !== EMOTEDRIVER_X64_SHA256)
      throw new EmoteUnsupportedError('mesh combinators for this DLL build');
  }

  /** 0x180058c50. */
  register(
    target: EmoteCombinatorTarget,
    defs: readonly EmoteMeshCombinator[],
    owner: object,
  ): void {
    if (defs.length === 0) return;
    const layer: CombinatorLayer = {
      target,
      owner,
      meshType: target.meshType,
      combinators: [],
      sum: new Float32Array(32),
    };
    for (const d of defs) {
      const c: Combinator = {
        def: d,
        cur: new Float32Array(32),
        prev: new Float32Array(32),
        changed: false,
        neutral: false,
      };
      layer.combinators.push(c);
      // 0x180059870: share an identical variable entry or create one.
      let list = this.variables.get(d.key);
      if (!list) this.variables.set(d.key, (list = []));
      let v = list.find(
        (e) =>
          e.meshType === target.meshType &&
          e.rangeBegin === d.rangeBegin &&
          e.rangeEnd === d.rangeEnd &&
          e.meshCount === d.meshCount,
      );
      if (!v) {
        v = {
          key: d.key,
          meshType: target.meshType,
          rangeBegin: f32(d.rangeBegin),
          rangeEnd: f32(d.rangeEnd),
          meshCount: d.meshCount,
          f: 0,
          members: [],
        };
        v.f = combinatorF(v, this.variablesSource.getVariable(d.key));
        list.push(v);
      }
      v.members.push(c);
      evalCombinator(c, v.f);
    }
    this.fullSum(layer);
    this.applyLayer(layer);
    this.layers.push(layer);
  }

  clear(): void {
    this.variables.clear();
    this.layers.length = 0;
  }

  unregister(owner: object): void {
    const gone = new Set<Combinator>();
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i]!;
      if (l.owner === owner) {
        for (const c of l.combinators) gone.add(c);
        this.layers.splice(i, 1);
      }
    }
    for (const [key, list] of this.variables) {
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i]!;
        for (let j = v.members.length - 1; j >= 0; j--)
          if (gone.has(v.members[j]!)) v.members.splice(j, 1);
        if (v.members.length === 0) list.splice(i, 1);
      }
      if (list.length === 0) this.variables.delete(key);
    }
  }

  get empty(): boolean {
    return this.layers.length === 0;
  }

  /** The combinator-variable contribution to 0x180038480. */
  expandVariableBounds(label: string, bounds: Float32Array): void {
    for (const variable of this.variables.get(label) ?? [])
      expandEmoteVariableBounds(bounds, variable.rangeBegin, variable.rangeEnd);
  }

  /** 0x180059e80. */
  update(): void {
    for (const list of this.variables.values()) {
      for (const v of list) {
        const f = combinatorF(v, this.variablesSource.getVariable(v.key));
        if (v.f === f) continue;
        v.f = f;
        for (const c of v.members) {
          const t = c.prev;
          c.prev = c.cur;
          c.cur = t;
          evalCombinator(c, f);
          c.changed = true;
        }
      }
    }
    for (const l of this.layers) {
      let n = 0;
      for (const c of l.combinators) if (c.changed) n++;
      if (n === 0) continue;
      if (n < l.combinators.length >>> 1) {
        for (const c of l.combinators) {
          if (!c.changed) continue;
          for (let k = 0; k < 32; k++) l.sum[k] = l.sum[k]! + c.cur[k]! - c.prev[k]!;
          c.changed = false;
        }
      } else this.fullSum(l);
      this.applyLayer(l);
    }
  }

  private fullSum(l: CombinatorLayer): void {
    l.sum.set(l.combinators[0]!.cur);
    l.combinators[0]!.changed = false;
    for (let j = 1; j < l.combinators.length; j++) {
      const c = l.combinators[j]!;
      for (let k = 0; k < 32; k++) l.sum[k]! += c.cur[k]!;
      c.changed = false;
    }
  }

  private applyLayer(l: CombinatorLayer): void {
    const allNeutral = l.combinators.every((c) => c.neutral);
    if (l.target.meshType === l.meshType && l.meshType === 1)
      l.target.applyCombinatorPatch(allNeutral ? null : l.sum);
  }
}
