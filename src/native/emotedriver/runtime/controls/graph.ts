import {type EmoteControlRequest, crtPow, emoteSign, f32, ftol} from './common.js';

/** A path segment: move linearly from `from` to `to` (a jump when they are equal). */
export type EmoteGraphSegment = readonly [from: number, to: number];

/**
 * `emote::EPGraph` (vtable 0x100718ec): the frame graph of an eye or eyebrow control.
 *
 * `edge` entries are closed frame ranges [a, b] along which the controlled variable moves
 * continuously. `node` entries are sets of frames that show the same picture, so the value
 * can jump between them. The loaders (0x10015890, 0x100171f0) read both as integers and
 * store them as floats.
 *
 * `search` (0x100080e0 with the depth-first walk 0x10008780) finds the shortest route from
 * the current frame to a target frame: a list of segments whose summed length is `total`.
 */
export class EmoteGraph {
  /** Edges as [a, b] (graph +0x4). */
  readonly edges: readonly (readonly [number, number])[];
  /** Nodes as frame lists (graph +0x14). */
  readonly nodes: readonly (readonly number[])[];
  /** Length of the last route found (graph +0x24). */
  total = 0;

  constructor(
    edges: readonly (readonly [number, number])[],
    nodes: readonly (readonly number[])[],
  ) {
    this.edges = edges.map(([a, b]) => [f32(ftol(a)), f32(ftol(b))] as const);
    this.nodes = nodes.map((n) => n.map((v) => f32(ftol(v))));
  }

  /** 0x10008420: first edge with a ≤ x ≤ b, or −1. */
  edgeAt(x: number): number {
    for (let i = 0; i < this.edges.length; i++) {
      const [a, b] = this.edges[i]!;
      if (a <= x && x <= b) return i;
    }
    return -1;
  }

  /** 0x10008470: first node containing `v`, or −1. */
  private nodeOf(v: number): number {
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i]!.includes(v)) return i;
    return -1;
  }

  /** 0x100084d0: first node holding a value in [lo, hi], or −1. */
  private nodeIn(lo: number, hi: number): number {
    for (let i = 0; i < this.nodes.length; i++)
      for (const v of this.nodes[i]!) if (lo <= v && v <= hi) return i;
    return -1;
  }

  /** 0x10008540: first value of node `j` not in `visited`, or −1. */
  private unvisited(j: number, visited: readonly number[]): number {
    for (const v of this.nodes[j]!) if (!visited.includes(v)) return v;
    return -1;
  }

  /**
   * 0x100080e0: route from `start` to `target`. Runs the walk (0x10008780) and selects the
   * first candidate with the smallest length below 99999 that did not fail. Without a
   * candidate the route is the single jump (target, target) and `total` is 0.
   */
  search(start: number, target: number): EmoteGraphSegment[] {
    const candidates = this.walk(f32(start), f32(target));
    let best = f32(99999),
      index = -1;
    for (let i = 0; i < candidates.length; i++) {
      const d = candidates[i]!.length;
      if (d !== -1 && d < best) {
        best = d;
        index = i;
      }
    }
    if (index === -1) {
      this.total = 0;
      return [[f32(target), f32(target)]];
    }
    this.total = best;
    return candidates[index]!.path.slice();
  }

  /**
   * 0x10008780: bounded depth-first walk. Moves forward along edges (to their end `b`),
   * jumps through a node to an unvisited frame, and backtracks over a stack of positions;
   * when no forward move is left it turns backward (towards edge starts) and finally tries
   * a node inside the current edge. Each arrival at the target's edge records a candidate;
   * the walk restarts from `start` (keeping the visited set) at most 10 times, and stops
   * when the stack is empty at an arrival or a dead end fails.
   */
  private walk(start: number, target: number): {path: EmoteGraphSegment[]; length: number}[] {
    const candidates: {path: EmoteGraphSegment[]; length: number}[] = [];
    const visited: number[] = [];
    let stack: number[] = [],
      path: EmoteGraphSegment[] = [],
      length = 0,
      direction = 1,
      current = start,
      lastStart = 0,
      state = 0,
      more = true;
    const addSegment = (from: number, to: number) => {
      length = f32(Math.abs(f32(to - from)) + length);
      path.push([from, to]);
    };
    const pop = () => {
      // 0x10008660 then the stack pop.
      current = stack.pop()!;
      const last = path.pop();
      if (last) length = f32(length - Math.abs(last[1] - last[0]));
    };
    const fail = () => {
      // 0x1000943a: the failed path is recorded with length −1.
      candidates.push({path: path.slice(), length: -1});
      more = false;
    };
    for (let iteration = 0; ;) {
      let finished = false;
      while (!finished) {
        switch (state) {
          case 0: {
            current = start;
            direction = 1;
            length = 0;
            path = [];
            stack = [];
            if (this.edgeAt(start) === -1 || this.edgeAt(target) === -1) {
              fail();
              finished = true;
            } else state = 1;
            break;
          }
          case 1: {
            if (this.edgeAt(current) === this.edgeAt(target)) {
              // 0x10009259: arrival. Both ends of the current edge become visitable again.
              const e = this.edgeAt(current);
              this.forget(visited, this.edges[e]![0]);
              this.forget(visited, this.edges[this.edgeAt(current)]![1]);
              addSegment(current, target);
              if (!candidates.some((c) => c.length === length))
                candidates.push({path: path.slice(), length});
              if (stack.length === 0) more = false;
              finished = true;
            } else state = direction === 1 ? 2 : 3;
            break;
          }
          case 2:
          case 3: {
            const forward = state === 2;
            const e = this.edgeAt(current);
            // The native code indexes edge −1 here; a node frame outside every edge does
            // not occur in data and is treated as a dead end.
            const end = e === -1 ? NaN : this.edges[e]![forward ? 1 : 0];
            if (!forward) lastStart = end;
            const j = e === -1 ? -1 : this.nodeOf(end);
            let next = -1;
            if (j !== -1) {
              visited.push(end);
              next = this.unvisited(j, visited);
            }
            if (j !== -1 && next !== -1) {
              addSegment(current, end);
              visited.push(next);
              stack.push(current);
              current = next;
              state = 1;
            } else if (stack.length) pop();
            else if (forward) {
              direction = -1;
              state = 3;
            } else {
              // 0x10009054: jump through a node inside the current edge.
              const hi = e === -1 ? NaN : this.edges[e]![1];
              const k = this.nodeIn(lastStart, hi);
              if (k === -1) {
                fail();
                finished = true;
                break;
              }
              const v1 = this.unvisited(k, visited);
              visited.push(v1);
              const v2 = this.unvisited(k, visited);
              if (v2 === -1) {
                fail();
                finished = true;
                break;
              }
              addSegment(current, v1);
              visited.push(v2);
              stack.push(current);
              current = v2;
              state = 1;
            }
            break;
          }
        }
      }
      iteration++;
      if (iteration >= 10 || !more) break;
      state = 0;
    }
    return candidates;
  }

  /** 0x10008730: removes every occurrence of `v`. */
  private forget(visited: number[], v: number): void {
    for (let i = visited.length - 1; i >= 0; i--) if (visited[i] === v) visited.splice(i, 1);
  }
}

/**
 * The graph-following motion shared by `EPEyeControl` (0x10005520, fields +0x54..+0xa8) and
 * `EPEyebrowControl` (0x10007da0, fields +0x3c..+0x88). A request (value, frames, weight)
 * is turned into a route; the route is walked with progress `t` advancing by
 * frames / duration and the travelled length following `t^weight · total`.
 */
export class EmoteGraphFollower {
  readonly graph: EmoteGraph;
  /** Request queue (+0x54 / +0x3c). */
  requests: EmoteControlRequest[] = [];
  /** Route segments still to walk (+0x98 / +0x74). */
  segments: EmoteGraphSegment[] = [];
  /** 0 idle, 1 between segments, 2 moving (+0x6c / +0x54). */
  state = 0;
  /** Current frame value (+0x70 / +0x58). */
  value: number;
  /** Direction of the running segment (+0x74 / +0x60). */
  sign = 0;
  /** End of the running segment (+0x78 / +0x64). */
  target = 0;
  /** Route length (+0x7c / +0x68). */
  total = 0;
  /** Travelled length (+0x80 / +0x6c). */
  travelled = 0;
  /** Easing exponent (+0x84 / +0x70). */
  weight = 0;
  /** 1 / duration (+0x8 / +0x5c). */
  rate = 0;

  constructor(graph: EmoteGraph, initial: number) {
    this.graph = graph;
    this.value = f32(initial);
  }

  /** Setter (0x10005460 / 0x10007ce0). */
  set(value: number, frames: number, weight: number, queued: boolean): void {
    if (!(frames > 0)) {
      this.requests = [];
      this.segments = [];
      this.value = f32(value);
      this.state = 0;
      return;
    }
    if (!queued) {
      this.requests = [];
      this.segments = [];
      this.state = 0;
    }
    this.requests.push({value: f32(value), frames: f32(frames), weight: f32(weight)});
  }

  /**
   * Motion part of the update. With an empty request queue, state 0 falls through to the
   * segment pop in the eye (0x100056d4) and returns in the eyebrow; the segment queue is
   * always empty in state 0, so both leave the state unchanged.
   */
  advance(frames: number): void {
    if (this.state === 0) {
      const request = this.requests.shift();
      if (!request) return;
      this.segments = this.graph.search(this.value, request.value);
      this.total = this.graph.total;
      this.state = 1;
      this.travelled = 0;
      this.rate = f32(1 / request.frames);
      this.weight = request.weight;
      return;
    }
    if (this.state === 1) {
      const segment = this.segments.shift();
      if (!segment) {
        this.state = 0;
        return;
      }
      const [a, b] = segment;
      if (b === a) this.value = b;
      else {
        this.value = a;
        this.target = b;
        this.sign = emoteSign(f32(b - a));
        this.state = 2;
      }
      return;
    }
    if (this.state !== 2) return;
    const t = f32(this.travelled / this.total);
    const inverse = f32(1 / this.weight);
    const eased = f32(crtPow(t, inverse));
    const next = f32(eased + this.rate * frames);
    const powered = f32(crtPow(next, this.weight));
    const along = f32(powered * this.total);
    const delta = f32(along - this.travelled);
    const value = f32(delta * this.sign + this.value);
    this.value = value;
    if ((this.sign > 0 && this.target <= value) || (this.sign < 0 && value <= this.target)) {
      // The overshoot is credited as (target − value) · sign, without the step's delta.
      this.state = 1;
      const credit = f32((this.target - value) * this.sign);
      this.value = this.target;
      this.travelled = f32(this.travelled + credit);
    } else this.travelled = f32(this.travelled + delta);
  }

  /**
   * `Skip` (eye 0x10017020, eyebrow 0x10018760): with queued requests the last request's
   * value becomes current and both queues are dropped; otherwise a running route jumps to
   * the end of its last segment (or of the running segment when none is left).
   */
  skip(): void {
    const last = this.requests[this.requests.length - 1];
    if (last) {
      this.state = 0;
      this.value = last.value;
      this.requests = [];
      this.segments = [];
      return;
    }
    if (this.state === 0) return;
    const segment = this.segments[this.segments.length - 1];
    this.value = segment ? segment[1] : this.target;
    this.segments = [];
    this.state = 0;
  }

  /** Running or queued (`IsAnimating` 0x100108f0). */
  get busy(): boolean {
    return this.state !== 0 || this.requests.length !== 0;
  }

  assign(source: EmoteGraphFollower): void {
    this.requests = source.requests.slice();
    this.segments = source.segments.slice();
    this.state = source.state;
    this.value = source.value;
    this.sign = source.sign;
    this.target = source.target;
    this.total = source.total;
    this.travelled = source.travelled;
    this.weight = source.weight;
    this.rate = source.rate;
  }
}
