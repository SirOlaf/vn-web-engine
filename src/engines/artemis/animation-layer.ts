import {artemisRevision} from './revision.js';

interface Owner<F> {
  readonly references: Map<F, number>;
  readonly release: (frame: F) => void;
}

/** CAnimationLayer state (vtable 0x14036ad40, constructor 0x1400b0db0): a std::map from
 * uint32 milliseconds (+0x300) to shared frame actors, where a null value marks the end
 * of one cycle. +0x310 is the timeGetTime start (0 = not started), +0x314 the current
 * key and +0x318 the remaining loop count (negative = endless).
 *
 * Frames are reference counted across copies: the copy constructor 0x1400b0e90 copies the
 * map of shared pointers together with start/current/loop, so copies share frame actors
 * but advance independently. */
export class ArtemisAnimationFrames<F extends object> {
  private readonly frames = new Map<number, F | null>();
  private keys: number[] = [];
  private start = 0;
  private key = 0;
  private loops = -1;
  private closed = false;
  private constructor(private readonly owner: Owner<F>) {}
  static create<F extends object>(
    executableSha256: string,
    release: (frame: F) => void,
  ): ArtemisAnimationFrames<F> {
    artemisRevision(executableSha256);
    return new ArtemisAnimationFrames({references: new Map(), release});
  }
  private check(): void {
    if (this.closed) throw Error('Artemis animation layer closed');
  }
  private retain(frame: F | null): void {
    if (frame) this.owner.references.set(frame, (this.owner.references.get(frame) ?? 0) + 1);
  }
  private drop(frame: F | null | undefined): void {
    if (!frame) return;
    const count = this.owner.references.get(frame);
    if (!count) throw Error('Artemis animation frame released twice');
    if (count > 1) this.owner.references.set(frame, count - 1);
    else {
      this.owner.references.delete(frame);
      this.owner.release(frame);
    }
  }
  /** std::map operator[] assignment: the previous value at `time` is released. */
  private set(time: number, frame: F | null): void {
    if (!this.frames.has(time)) {
      this.keys.push(time);
      this.keys.sort((a, b) => a - b);
    }
    const old = this.frames.get(time);
    this.frames.set(time, frame);
    this.retain(frame);
    this.drop(old);
  }
  /** Virtual +0x140 (0x140156190): clear the map, store `frame` at key 0, reset the start
   * time, mark the layer dirty and restore the endless loop count. Takes ownership. */
  reset(frame: F): void {
    this.check();
    const old = [...this.frames.values()];
    this.frames.clear();
    this.keys = [];
    this.retain(frame);
    this.frames.set(0, frame);
    this.keys.push(0);
    for (const value of old) this.drop(value);
    this.start = 0;
    this.key = 0;
    this.loops = -1;
  }
  /** Virtual +0x148 (0x1401562b0): key 0 is ignored; otherwise operator[] replaces the
   * value at `time`. `null` is the `end` marker. Takes ownership of `frame`. */
  add(frame: F | null, time: number): void {
    this.check();
    time >>>= 0;
    if (time === 0) {
      this.retain(frame);
      this.drop(frame);
      return;
    }
    this.set(time, frame);
  }
  /** Virtual +0x158 (0x1400b1220). */
  setLoop(count: number): void {
    this.check();
    this.loops = count | 0;
  }
  /** Virtual +0x168 (0x140156400), run by both draw passes before forwarding to the
   * current frame. `now` is timeGetTime as uint32. Returns whether the layer was marked
   * dirty (+0x44 |= 4). */
  update(now: number): boolean {
    this.check();
    now >>>= 0;
    if (this.start === 0) this.start = now;
    let first = true,
      dirty = false;
    for (;;) {
      if (!this.frames.has(this.key)) return dirty;
      let index = this.keys.indexOf(this.key) + 1;
      let restarted = false;
      for (; index < this.keys.length; index++) {
        const time = this.keys[index]!;
        if ((now - this.start) >>> 0 < time) return dirty;
        if (this.frames.get(time) === null) {
          if (this.loops === 0) return dirty;
          if (this.loops > 0) this.loops--;
          dirty = true;
          this.start = (this.start + time) >>> 0;
          first = false;
          this.key = 0;
          restarted = true;
          break;
        }
        dirty = true;
        this.key = time;
      }
      if (!restarted && first) return dirty;
    }
  }
  /** Draw passes 0x1400b1240/0x1400b12a0 read map[current]; a missing or end entry would
   * dereference null natively. */
  frame(): F {
    this.check();
    const frame = this.frames.get(this.key);
    if (!frame) throw Error('Unsupported Artemis animation without a current frame');
    return frame;
  }
  /** Current key and loop counter for fingerprints and diagnostics. */
  get state(): {readonly key: number; readonly loops: number; readonly started: boolean} {
    return {key: this.key, loops: this.loops, started: this.start !== 0};
  }
  /** Map entries in ascending key order; `null` is an end marker. */
  entries(): readonly (readonly [number, F | null])[] {
    return this.keys.map((key) => [key, this.frames.get(key)!] as const);
  }
  /** 0x1400b0e90 with copy flag: shared frames, copied start/current/loop. */
  copy(): ArtemisAnimationFrames<F> {
    this.check();
    const copy = new ArtemisAnimationFrames(this.owner);
    for (const key of this.keys) {
      const frame = this.frames.get(key)!;
      copy.retain(frame);
      copy.frames.set(key, frame);
    }
    copy.keys = [...this.keys];
    copy.start = this.start;
    copy.key = this.key;
    copy.loops = this.loops;
    return copy;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const frames = [...this.frames.values()];
    this.frames.clear();
    this.keys = [];
    for (const frame of frames) this.drop(frame);
  }
}
