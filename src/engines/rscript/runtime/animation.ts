import {parseFsc, type FscInstruction} from '../../../formats/rscript/fsc.js';
import type {RScriptFiles} from '../files.js';
import type {RScriptSurface} from '../graphics/pixels.js';
import type {RScriptImages} from '../images.js';

export interface AnimationFrame {
  readonly surface: RScriptSurface | null;
  readonly x: number;
  readonly y: number;
}

/** Frames of `<path>.lwg` and the optional `<path>.fsc` script that sequences them. */
export interface FrameAnimation {
  readonly frames: readonly AnimationFrame[];
  readonly code: readonly FscInstruction[] | null;
}

/** sub_42C170: loads every frame up front, then compiles the frame script if present. */
export async function loadFrameAnimation(
  images: RScriptImages,
  files: RScriptFiles,
  path: string,
): Promise<FrameAnimation | null> {
  const lwg = await images.lwg(path);
  if (!lwg) return null;
  const frames = await Promise.all(
    lwg.entries.map(async (entry, i) => ({
      surface: await images.lwgFrame(path, i),
      x: entry.x,
      y: entry.y,
    })),
  );
  const script = await files.read(`${path}.fsc`);
  return {frames, code: script ? parseFsc(script) : null};
}

/** Instructions run in one tick before a script without frames is treated as stuck. */
const STEP_LIMIT = 65536;

/**
 * Frame-script player of the animated layer sprite (0x42BF50). Each tick runs instructions
 * until a frame or hold consumes the tick; without a script the frames play in order and
 * loop. `step` returns false once the animation has ended.
 */
export class FramePlayer {
  private pc = 0;
  frame = 0;
  running = true;

  constructor(
    readonly animation: FrameAnimation,
    private readonly loop = true,
  ) {}

  step(variable: (index: number) => number, random: () => number): boolean {
    if (!this.running) return false;
    const {code, frames} = this.animation;
    if (!code) {
      let next = this.frame + 1;
      if (next >= frames.length) {
        if (!this.loop) return (this.running = false);
        next = 0;
      }
      this.frame = next;
      if (next + 1 === frames.length && !this.loop) this.running = false;
      return true;
    }
    for (let steps = 0; steps < STEP_LIMIT; steps++) {
      const instruction: FscInstruction = code[this.pc++] ?? {op: 'end'};
      switch (instruction.op) {
        case 'end':
          return (this.running = false);
        case 'frame':
          this.frame = instruction.frame;
          return true;
        case 'hold':
          return true;
        case 'jump':
          this.pc = instruction.target;
          break;
        case 'if':
          if (variable(instruction.variable) === instruction.value) this.pc = instruction.target;
          break;
        case 'random':
          if (instruction.range > 0 && random() % instruction.range === 0)
            this.pc = instruction.target;
          break;
      }
    }
    return (this.running = false);
  }
}
