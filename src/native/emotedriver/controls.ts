/**
 * Automatic face controls of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`): the gaze graph walk
 * (`EPEyeControl`, `EPEyebrowControl`), blinking, the mouth tween, `selectorControl` and
 * `orbitControl`. Each control is stepped from the Progress sub-step loop (0x18000d3f0) and
 * writes its result into the player's variable values.
 */

import {EmoteTween, powf} from './tween.js';

const f32 = Math.fround;
const NONE = -1;
/** `float` 99999: candidates at or above it are ignored (0x181fcd5c8). */
const COST_LIMIT = f32(99999);
/** Search restarts (0x180029470). */
const SEARCH_LIMIT = 10;
const REACH_EPSILON = f32(0.0001);
/** Blink speed factor 2.5 (0x181fcd578) and hold divisor 5 (0x181fcd58c). */
const BLINK_SPEED = f32(2.5);
const BLINK_HOLD = f32(5);
/** `FLT_EPSILON` (0x181fcd510). */
const FLT_EPSILON = f32(2 ** -23);

/**
 * Process-wide generator of 0x180028950, an xorshift variant whose last word mixes
 * `((w >> 11) ^ t) >> 8`. The native fourth word is seeded from `_time64`.
 */
export class EmoteRandom {
  private s0 = 123456789;
  private s1 = 362436069;
  private s2 = 521288629;
  private s3: number;

  constructor(seed: number) {
    this.s3 = seed >>> 0;
  }

  /** A float in [0, 1): 23 random mantissa bits under exponent 0. */
  next(): number {
    const t = (this.s0 ^ (this.s0 << 11)) >>> 0;
    this.s0 = this.s1;
    this.s1 = this.s2;
    this.s2 = this.s3;
    this.s3 = ((((this.s3 >>> 11) ^ t) >>> 8) ^ this.s3 ^ t) >>> 0;
    return f32(1 + (this.s3 & 0x7fffff) / 0x800000) - 1;
  }
}

type Segment = readonly [number, number];

interface Candidate {
  readonly segments: Segment[];
  readonly cost: number;
}

/**
 * `EPGraph`: value ranges (`edge`, integer pairs read as floats) joined by nodes (`node`,
 * lists of values that connect ranges). `path` finds a walk from one value to another that
 * stays inside ranges and crosses between them only through node values.
 */
export class EmoteGraph {
  /** Cost of the last path (`+0x38`). */
  cost = 0;

  constructor(
    readonly edges: readonly Segment[],
    readonly nodes: readonly (readonly number[])[],
  ) {}

  /** 0x180029310. */
  edgeOf(x: number): number {
    for (let i = 0; i < this.edges.length; i++) {
      const [lo, hi] = this.edges[i]!;
      if (lo <= x && x <= hi) return i;
    }
    return NONE;
  }

  /** 0x180029350: the first value of node `k` not yet visited. */
  private firstUnvisited(k: number, visited: readonly number[]): number {
    for (const v of this.nodes[k]!) if (!visited.includes(v)) return v;
    return NONE;
  }

  /** 0x1800290e0: the cheapest candidate's segments, or the single segment (to, to). */
  path(from: number, to: number): Segment[] {
    const candidates = this.search(f32(from), f32(to));
    let best = NONE;
    let bestCost = COST_LIMIT;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!.cost;
      if (c !== -1 && c < bestCost) {
        best = i;
        bestCost = c;
      }
    }
    if (best === NONE) {
      this.cost = 0;
      return [[to, to]];
    }
    this.cost = bestCost;
    return candidates[best]!.segments.slice();
  }

  /** 0x180029470: a depth-first walk restarted up to ten times, keeping visited values. */
  private search(from: number, to: number): Candidate[] {
    const candidates: Candidate[] = [];
    const visited: number[] = [];
    const stack: number[] = [];
    let segments: Segment[] = [];
    let cost = 0;
    let dirFlag = 1;
    let iterations = 0;
    let pos = from;
    const fail = (): void => {
      candidates.push({segments: segments.slice(), cost: -1});
    };
    const walk = (pt: number): void => {
      cost = f32(cost + Math.abs(f32(pt - pos)));
      segments.push([pos, pt]);
    };
    const backtrack = (): boolean => {
      if (stack.length === 0) return false;
      pos = stack[stack.length - 1]!;
      const last = segments.pop();
      if (last) cost = f32(cost - Math.abs(f32(last[1] - last[0])));
      stack.pop();
      return true;
    };
    outer: for (;;) {
      // State 0.
      dirFlag = 1;
      cost = 0;
      segments = [];
      stack.length = 0;
      if (this.edges.length < 1 || this.edgeOf(from) === NONE || this.edgeOf(to) === NONE) {
        fail();
        break;
      }
      pos = from;
      let state = 1;
      for (;;) {
        if (state === 1) {
          const e = this.edgeOf(pos);
          if (e !== this.edgeOf(to)) {
            state = dirFlag === 1 ? 2 : 3;
            continue;
          }
          const [lo, hi] = this.edges[e]!;
          removeAll(visited, lo);
          removeAll(visited, hi);
          walk(to);
          if (!candidates.some((c) => c.cost === cost)) {
            candidates.push({segments: segments.slice(), cost});
          }
          if (stack.length === 0) break outer;
          if (++iterations >= SEARCH_LIMIT) break outer;
          continue outer;
        }
        const up = state === 2;
        const edge = this.edges[this.edgeOf(pos)]!;
        const end = up ? edge[1] : edge[0];
        const k = this.nodes.findIndex((n) => n.includes(end));
        let moved = false;
        if (k !== NONE) {
          visited.push(end);
          const next = this.firstUnvisited(k, visited);
          if (next !== NONE) {
            walk(end);
            visited.push(next);
            stack.push(pos);
            pos = next;
            state = 1;
            moved = true;
          }
        }
        if (moved) continue;
        if (backtrack()) continue;
        if (up) {
          dirFlag = -1;
          state = 3;
          continue;
        }
        // Interior approach: a node value inside the current range.
        const [lo, hi] = this.edges[this.edgeOf(pos)]!;
        const n = this.nodes.findIndex((values) => values.some((v) => lo <= v && v <= hi));
        if (n === NONE) {
          fail();
          break outer;
        }
        const a = this.firstUnvisited(n, visited);
        visited.push(a);
        const b = this.firstUnvisited(n, visited);
        if (b === NONE) {
          fail();
          break outer;
        }
        walk(a);
        visited.push(b);
        stack.push(pos);
        pos = b;
        state = 1;
      }
    }
    return candidates;
  }
}

function removeAll(values: number[], value: number): void {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] === value) values.splice(i, 1);
}

interface WalkEntry {
  readonly value: number;
  readonly frames: number;
  readonly power: number;
}

/**
 * The graph walker shared by the eye (+0x20…+0xd0) and eyebrow (+0x8…+0xa8) controls: the
 * value moves along the path's segments with `powf` easing over the whole path length.
 */
export class EmoteGraphWalker {
  private queue: WalkEntry[] = [];
  private segments: Segment[] = [];
  /** 0 idle, 1 next segment, 2 moving. */
  state = 0;
  current: number;
  private inv = 0;
  private dir = 1;
  private target = 0;
  private total = 0;
  private traveled = 0;
  private power = 0;

  constructor(
    readonly graph: EmoteGraph,
    begin: number,
  ) {
    this.current = f32(begin);
  }

  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /** setVariable kinds 4 and 5. */
  set(value: number, frames: number, power: number, queuing: boolean): void {
    const v = f32(value);
    const fr = f32(frames);
    if (fr > 0) {
      if (queuing) {
        this.queue.push({value: v, frames: fr, power});
        return;
      }
      if (this.state !== 0) {
        const last = this.segments.length
          ? this.segments[this.segments.length - 1]![1]
          : this.target;
        const remaining = f32(
          f32(1 - powf(f32(this.traveled / this.total), f32(1 / this.power))) / this.inv,
        );
        if (last === v && remaining < fr) return;
      }
      this.queue = [{value: v, frames: fr, power}];
      this.segments = [];
      this.state = 0;
      return;
    }
    this.queue = [];
    this.segments = [];
    this.state = 0;
    this.current = v;
  }

  /** 0x180015400 / 0x180016110: jumps to the final queued or targeted value. */
  skip(): void {
    const last = this.queue[this.queue.length - 1];
    if (last) {
      this.state = 0;
      this.current = last.value;
      this.queue = [];
      this.segments = [];
      return;
    }
    if (this.state !== 0) {
      this.current = this.segments.length
        ? this.segments[this.segments.length - 1]![1]
        : this.target;
      this.segments = [];
      this.state = 0;
    }
  }

  /** The walk part of 0x180028ab0 and 0x180027f20. */
  step(frames: number): void {
    const dt = f32(frames);
    for (;;) {
      if (this.state === 0) {
        const entry = this.queue.shift();
        if (!entry) return;
        this.segments = this.graph.path(this.current, entry.value);
        this.state = 1;
        this.total = this.graph.cost;
        this.traveled = 0;
        this.inv = f32(1 / entry.frames);
        this.power = entry.power;
        continue;
      }
      if (this.state === 1) {
        const seg = this.segments.shift();
        if (!seg) {
          this.state = 0;
          continue;
        }
        const [from, to] = seg;
        if (from === to) {
          this.current = to;
          continue;
        }
        this.target = to;
        this.current = from;
        this.dir = f32(to - from) >= 0 ? 1 : -1;
        this.state = 2;
        continue;
      }
      const u = f32(
        powf(f32(this.traveled / this.total), f32(1 / this.power)) + f32(dt * this.inv),
      );
      const delta = f32(f32(powf(u, this.power) * this.total) - this.traveled);
      const cur = f32(this.current + f32(this.dir * delta));
      const reached =
        this.dir > 0
          ? !(f32(cur - this.target) < -REACH_EPSILON)
          : !(f32(cur - this.target) > REACH_EPSILON);
      if (!reached) {
        this.current = cur;
        this.traveled = f32(this.traveled + delta);
        return;
      }
      this.traveled = f32(f32(f32(this.target - cur) * this.dir) + f32(this.traveled + delta));
      this.current = this.target;
      this.state = 1;
    }
  }
}

export interface EmoteEyeSettings {
  readonly label: string;
  readonly beginFrame: number;
  readonly endFrame: number;
  readonly blinkIntervalMin: number;
  readonly blinkIntervalMax: number;
  readonly blinkFrameCount: number;
  readonly blinkEnabled: boolean;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
}

/** `EPEyeControl` (0xf8 bytes, loader 0x180014640, step 0x180028ab0). */
export class EmoteEyeControl {
  readonly label: string;
  readonly walker: EmoteGraphWalker;
  private readonly begin: number;
  private readonly end: number;
  private readonly blinkMin: number;
  private readonly blinkMax: number;
  private readonly blinkFrames: number;
  /** +0xc8 (the API toggles it). */
  blinkEnabled: number;
  /** +0xbc: 0 open, 10 closing, 11 closed, 12 opening. */
  blinkState = 0;
  private blinkPos: number;
  private blinkTimer: number;

  constructor(
    s: EmoteEyeSettings,
    private readonly random: EmoteRandom,
  ) {
    this.label = s.label;
    this.begin = f32(s.beginFrame);
    this.end = f32(s.endFrame);
    this.blinkMin = f32(s.blinkIntervalMin);
    this.blinkMax = f32(s.blinkIntervalMax);
    this.blinkFrames = f32(s.blinkFrameCount);
    this.blinkEnabled = s.blinkEnabled ? 1 : 0;
    this.walker = new EmoteGraphWalker(
      new EmoteGraph(
        s.edge.map(([a, b]) => [f32(a), f32(b)] as const),
        s.node.map((n) => n.map(f32)),
      ),
      this.begin,
    );
    this.blinkPos = this.begin;
    this.blinkTimer = this.interval();
  }

  /** `setBlinkEnabled`: disabling restarts the blink cycle with an open eye. */
  setBlinkEnabled(enabled: boolean): void {
    const b = enabled ? 1 : 0;
    if (b === this.blinkEnabled) return;
    this.blinkEnabled = b;
    if (b === 0) {
      this.blinkState = 0;
      this.blinkPos = this.begin;
      this.blinkTimer = this.interval();
    }
  }

  private interval(): number {
    return f32(f32(this.random.next() * f32(this.blinkMax - this.blinkMin)) + this.blinkMin);
  }

  /** Steps the walk and the blink, then returns the output value. */
  step(frames: number): number {
    const dt = f32(frames);
    this.walker.step(dt);
    const speed = f32(f32(dt * BLINK_SPEED) / this.blinkFrames);
    const range = f32(this.end - this.begin);
    for (;;) {
      if (this.blinkState === 0) {
        if (this.blinkEnabled !== 0 && Math.trunc(this.blinkPos) === this.begin) {
          this.blinkTimer = f32(this.blinkTimer - dt);
          if (this.blinkTimer <= 0) {
            this.blinkState = 10;
            continue;
          }
        }
        break;
      }
      if (this.blinkState === 10) {
        this.blinkPos = f32(this.blinkPos + f32(range * speed));
        if (this.blinkPos >= this.end) {
          this.blinkState = 11;
          this.blinkPos = this.end;
          this.blinkTimer = f32(this.blinkFrames / BLINK_HOLD);
        }
        break;
      }
      if (this.blinkState === 11) {
        this.blinkTimer = f32(this.blinkTimer - dt);
        if (this.blinkTimer <= 0) {
          this.blinkState = 12;
          this.blinkTimer = this.interval();
        }
        break;
      }
      if (this.blinkState === 12) {
        this.blinkPos = f32(this.blinkPos - f32(speed * range));
        if (this.blinkPos <= this.begin) {
          this.blinkPos = this.begin;
          this.blinkState = 0;
          continue;
        }
        break;
      }
      break;
    }
    return this.output();
  }

  output(): number {
    const cur = this.walker.current;
    if (this.begin <= cur && cur <= this.end) {
      return f32(
        f32(
          f32(f32(this.blinkPos - this.begin) * f32(this.end - cur)) / f32(this.end - this.begin),
        ) + cur,
      );
    }
    return cur;
  }
}

export interface EmoteEyebrowSettings {
  readonly label: string;
  readonly beginFrame: number;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
}

/** `EPEyebrowControl` (loader 0x180015540, step 0x180027f20): the walk without blinking. */
export class EmoteEyebrowControl {
  readonly label: string;
  readonly walker: EmoteGraphWalker;

  constructor(s: EmoteEyebrowSettings) {
    this.label = s.label;
    this.walker = new EmoteGraphWalker(
      new EmoteGraph(
        s.edge.map(([a, b]) => [f32(a), f32(b)] as const),
        s.node.map((n) => n.map(f32)),
      ),
      f32(s.beginFrame),
    );
  }

  step(frames: number): number {
    this.walker.step(frames);
    return this.walker.current;
  }
}

/**
 * `mouthControl` entry (+0x168, 0x48 bytes): `label` holds an integer shape index, `talkLabel`
 * a tweened opening.
 */
export class EmoteMouthControl {
  /** Object +0x34. */
  shape = 0;
  readonly talk = new EmoteTween(1);

  constructor(
    readonly label: string,
    readonly talkLabel: string,
  ) {}
}

export interface EmoteSelectorOption {
  /** The linked `transitionControl` tween, or null when no entry has the label. */
  readonly tween: EmoteTween | null;
  readonly offValue: number;
  readonly onValue: number;
}

/** `EPSelectorControl` (0x58 bytes, loader 0x180017a50): one option on, the others off. */
export class EmoteSelectorControl {
  private queue: WalkEntry[] = [];
  /** +0x30. */
  selected = 0;
  private state = 0;
  private inv = 0;
  private t = 0;

  constructor(
    readonly label: string,
    readonly options: readonly EmoteSelectorOption[],
  ) {
    this.select(0, 0, 0);
  }

  /** 0x18002bfa0. */
  private select(index: number, frames: number, power: number): void {
    this.selected = index;
    for (let i = 0; i < this.options.length; i++) {
      const o = this.options[i]!;
      if (!o.tween) continue;
      const target = i === index ? o.onValue : o.offValue;
      const cur = o.tween.step(0)[0]!;
      if (o.tween.busy || Math.abs(f32(cur - target)) >= FLT_EPSILON) {
        const span = Math.abs(f32(f32(cur - target) / f32(o.onValue - o.offValue)));
        o.tween.set([target], f32(span * f32(frames)), power, false);
      }
    }
  }

  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /** setVariable kind 8. */
  set(value: number, frames: number, power: number, queuing: boolean): void {
    const fr = f32(frames);
    if (fr <= 0) {
      this.queue = [];
      this.state = 0;
      this.select(Math.trunc(value), 0, 0);
      return;
    }
    if (queuing) {
      this.queue.push({value: f32(value), frames: fr, power});
      return;
    }
    this.queue = [{value: f32(value), frames: fr, power}];
    this.state = 0;
  }

  /** 0x180018450. */
  skip(): void {
    const last = this.queue[this.queue.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.select(this.selected, 0, 0);
      }
      return;
    }
    this.state = 0;
    this.select(Math.trunc(last.value), 0, 0);
    this.queue = [];
  }

  /** Returns the selected index as the variable value. */
  step(frames: number): number {
    const dt = f32(frames);
    for (;;) {
      if (this.state !== 0) {
        if (this.state === 1) {
          this.t = f32(f32(dt * this.inv) + this.t);
          if (f32(this.t - 1) < -REACH_EPSILON) break;
          this.t = 1;
          this.state = 0;
        }
      }
      const entry = this.queue.shift();
      if (!entry) break;
      this.select(Math.trunc(entry.value), entry.frames, entry.power);
      this.state = 1;
      this.t = 0;
      this.inv = f32(1 / entry.frames);
    }
    return this.selected;
  }
}

export interface EmoteOrbitSettings {
  readonly label: string;
  readonly interval: number;
  readonly tween: boolean;
  readonly orbitFrameList: readonly number[];
}

/** `orbitControl` entry (+0x290, 0x48 bytes, loader 0x18001b190): a cycling value list. */
export class EmoteOrbitControl {
  readonly label: string;
  private reset = true;
  private time = 0;
  private readonly interval: number;
  private readonly tween: boolean;
  private readonly values: readonly number[];

  constructor(s: EmoteOrbitSettings) {
    this.label = s.label;
    this.interval = f32(s.interval);
    this.tween = s.tween;
    this.values = s.orbitFrameList.map(f32);
  }

  /** Returns the `setVariable` call the step makes, or null. */
  step(frames: number): {value: number; frames: number} | null {
    const n = this.values.length;
    let index: number;
    if (this.reset) {
      this.time = 0;
      this.reset = false;
      index = 0;
    } else {
      const old = this.time;
      this.time = fmodf(f32(old + f32(frames)), this.interval);
      index = Math.trunc(f32(f32(this.time * n) / this.interval));
      if (index === Math.trunc(f32(f32(n * old) / this.interval))) return null;
    }
    const value = this.values[index] ?? 0;
    const fr = this.tween ? f32(f32(f32(this.interval / n) * (index + 1)) - this.time) : 0;
    return {value, frames: fr};
  }
}

/** CRT `fmodf`. */
export function fmodf(x: number, y: number): number {
  return f32(f32(x) % f32(y));
}
