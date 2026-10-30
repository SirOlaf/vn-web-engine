import {artemisRevision} from './revision.js';
import {
  ArtemisTheoraThreads,
  artemisTheoraPicture,
  readStream,
  type ArtemisTheoraThreadState,
} from './video-thread.js';

/** The CTheora decode threads as `ArtemisTheoraVideo` drives them. */
export interface ArtemisTheoraDecodeThreads {
  readonly hasMask: boolean;
  /** Update's wait: null while a thread is still short of its target; otherwise the main
   * stream state, with `picture` true when a new picture was written to `pixels`. */
  settle(pixels: Uint8Array): (ArtemisTheoraThreadState & {readonly picture: boolean}) | null;
  /** Sets both stream targets; the threads decode toward them. */
  setTarget(frame: number): void;
  close(): void;
}

/** Opens decode threads for a main stream, its loop flag and the mask stream bytes. The
 * main stream has been checked to be Theora. */
export type ArtemisTheoraThreadOpener = (
  main: Uint8Array,
  loop: boolean,
  mask: Uint8Array | null,
) => ArtemisTheoraDecodeThreads;

/** Decode threads run on the caller's thread: settle decodes up to the target at once,
 * which is the state native reaches after its wait. */
export const synchronousTheoraThreads: ArtemisTheoraThreadOpener = (main, loop, mask) => {
  const threads = ArtemisTheoraThreads.open(main, loop, mask)!;
  return {
    hasMask: threads.hasMask,
    settle: (pixels) => {
      const picture = threads.decode(pixels);
      return {...threads.state, picture};
    },
    setTarget: (frame) => threads.setTarget(frame),
    close: () => {},
  };
};

/** Native CTheora video decoder object (vtable 0x1403636f8) behind the `video` tag's layer
 * actor. Its decode threads (`video-thread.ts`) run through an `ArtemisTheoraThreadOpener`:
 * on the caller's thread by default, or in a worker. Native update waits until the main
 * thread reached its target; here an update that finds the threads still decoding returns
 * without effect, so the picture and the frame clock wait for the next update instead of
 * blocking the frame.
 *
 * The surface is the picture region in RGBA. */
export class ArtemisTheoraVideo {
  readonly width: number;
  readonly height: number;
  /** RGBA picture; contents change when `revision` changes. */
  readonly pixels: Uint8Array;
  revision = 0;
  /** +0x28 finish callback, run when update finds the stream finished. */
  onFinish: (() => void) | null = null;
  /** +0x40 */
  private readonly frameMs: number;
  /** +0x204 */
  private readonly skipCap: number;
  /** +0x2c, constructor default -1. */
  private delayMargin = -1;
  /** +0x224 timeGetTime of the first update; 0 = not started. */
  private start = 0;
  private open = true;
  /** Main stream +0x220, +0x228 and +0x22c. */
  private ended = false;
  private decoded = -1;
  private target = 0;

  private constructor(
    executableSha256: string,
    picture: {readonly width: number; readonly height: number; readonly frameRate: number},
    private readonly threads: ArtemisTheoraDecodeThreads,
  ) {
    artemisRevision(executableSha256);
    this.width = picture.width;
    this.height = picture.height;
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.frameMs = Math.fround(1000 / picture.frameRate);
    this.skipCap = Math.ceil(picture.frameRate) | 0;
  }

  /** Open 0x140015d00 with the stream open 0x140016c40. Returns null when `bytes` is not
   * a Theora stream (native returns 1). A mask that fails to open is dropped (0x140017360). */
  static open(
    executableSha256: string,
    bytes: Uint8Array,
    loop: boolean,
    maskBytes: Uint8Array | null,
    threads: ArtemisTheoraThreadOpener = synchronousTheoraThreads,
  ): ArtemisTheoraVideo | null {
    const main = readStream(bytes);
    if (!main) return null;
    return new ArtemisTheoraVideo(
      executableSha256,
      artemisTheoraPicture(main),
      threads(bytes, loop, maskBytes),
    );
  }

  /** Slot +0x18: the end flag +0x220 is clear. */
  get playing(): boolean {
    return !this.ended;
  }
  get hasMask(): boolean {
    return this.threads.hasMask;
  }
  /** Main stream frame counters, for diagnostics. */
  get frame(): {readonly decoded: number; readonly target: number} {
    return {decoded: this.decoded, target: this.target};
  }

  /** Slot +0x20: `delaymargin` in milliseconds; negative disables frame skipping. */
  setDelayMargin(milliseconds: number): void {
    this.delayMargin = milliseconds | 0;
  }

  /** Slot +0x30: sets the end flag and releases the decoder. */
  close(): void {
    this.ended = true;
    if (this.open) this.threads.close();
    this.open = false;
  }

  /** Slot +0x10 (0x140016390) with `now` as timeGetTime. */
  update(now: number): void {
    if (!this.open) return;
    // The mask thread decodes to the same target; settle covers both threads and converts
    // a new main or mask frame.
    const state = this.threads.settle(this.pixels);
    if (!state) return;
    this.ended = state.ended;
    this.decoded = state.decoded;
    if (state.ended && this.target > state.decoded) {
      this.close();
      this.onFinish?.();
      return;
    }
    if (this.start === 0) this.start = now >>> 0;
    if (state.picture) this.revision++;
    const elapsed = Math.trunc(
      Math.floor(Math.fround(Math.fround(((now >>> 0) - this.start) >>> 0) / this.frameMs)),
    );
    const behind = elapsed - this.target;
    if (behind < 0) return;
    const next = this.target + 1;
    this.target = next;
    if (
      behind !== 0 &&
      this.delayMargin >= 0 &&
      Math.fround(this.delayMargin) < Math.fround(Math.fround(behind) * this.frameMs)
    )
      this.target = Math.min(behind, this.skipCap) + next;
    this.threads.setTarget(this.target);
  }
}

/** 0x140015d00 mask name: the opened name's stem, `_m.`, then its extension. */
export function artemisVideoMaskName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? `${name}_m.` : `${name.slice(0, dot)}_m.${name.slice(dot + 1)}`;
}
