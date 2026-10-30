import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';

/**
 * `MMotionPlayer` clock and scan order for the exact x86/x64 images in `build.ts`
 * (0x1003aaf0 / 0x18003f7f0). Frame storage and scan side effects belong to the clip.
 */
export abstract class EmoteClipTime {
  private readonly x64: boolean;
  /** x86 +0x110/+0x111/+0x113/+0x114, x64 +0x188/+0x189/+0x18b/+0x18c. */
  playing = false;
  jumped = true;
  starting = false;
  replay = false;
  syncStop = false;
  alignStop = false;
  /** x86 +0x118/+0x11c, x64 +0x190/+0x194: running and clamped frame positions. */
  timeRunning = 0;
  time = 0;
  speed = 1;
  step = 0;
  loopTime = 0;
  lastTime = 0;

  protected constructor(driverSha256 = EMOTEDRIVER_X86_SHA256) {
    this.x64 = emoteBuild(driverSha256) === EMOTEDRIVER_X64_SHA256;
  }

  protected abstract readonly motionParameter: {readonly position: number} | null;
  protected abstract readonly parameters: readonly unknown[];
  protected abstract resetFrames(): void;
  protected abstract scanForward(): void;
  protected abstract scanBackward(): void;
  protected abstract scanParameterNodes(): void;

  advance(frames: number): void {
    const x64 = this.x64;
    if (!x64) this.alignStop = false;
    this.step = Math.fround(x64 ? frames * this.speed : this.speed * frames);
    const cell = this.motionParameter;
    if (cell !== null) {
      const parameter = cell.position;
      if (this.starting) {
        this.timeRunning = this.time = parameter;
        this.starting = false;
        this.resetFrames();
      } else if (this.time < parameter) {
        this.timeRunning = this.time = parameter;
        this.scanForward();
      } else if (parameter < this.time) {
        this.timeRunning = this.time = parameter;
        this.scanBackward();
      } else this.scanParameterNodes();
      return;
    }
    if (!this.starting && !this.playing) {
      if (this.parameters.length) this.scanParameterNodes();
      return;
    }
    if (this.syncStop || this.alignStop) return;
    let stepped = false;
    if (this.starting) {
      this.starting = false;
      if (this.step < 0 && this.timeRunning === 0) this.time = this.timeRunning = this.lastTime;
      if (this.replay) {
        this.replay = false;
        // X64 replays forward at zero delta; x86 takes the backward seek path.
        if (x64 ? !(this.step < 0) : this.step > 0) {
          const saved = this.time;
          this.time = 0;
          this.resetFrames();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          this.time = saved;
          this.scanForward();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          stepped = true;
        } else if (x64 ? !(this.lastTime <= this.timeRunning) : this.timeRunning < this.lastTime) {
          const saved = this.time;
          this.time = this.lastTime;
          this.resetFrames();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          this.time = saved;
          this.scanBackward();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          stepped = true;
        }
      }
      if (!stepped) {
        this.resetFrames();
        if (!x64 && (this.syncStop || this.alignStop)) return;
      }
    }
    const jumped = this.jumped;
    if (!jumped) {
      this.timeRunning = Math.fround(this.step + this.timeRunning);
      this.time = x64
        ? this.timeRunning < this.lastTime
          ? this.timeRunning
          : this.lastTime
        : this.lastTime <= this.timeRunning
          ? this.lastTime
          : this.timeRunning;
    }
    if (this.step >= 0) {
      if (this.lastTime <= this.timeRunning) {
        this.time = this.lastTime;
        if (this.loopTime >= 0) {
          this.scanForward();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          this.time = this.loopTime;
          this.resetFrames();
          if (!x64 && (this.syncStop || this.alignStop)) return;
          if (x64) {
            let value = this.timeRunning;
            if (this.lastTime <= value) {
              if (this.lastTime - this.loopTime > 0)
                while (this.lastTime <= value)
                  value = Math.fround(Math.fround(value - this.lastTime) + this.loopTime);
              else value = this.loopTime;
            }
            this.timeRunning = value;
          } else {
            while (this.lastTime <= this.timeRunning)
              this.timeRunning = Math.fround(this.timeRunning - this.lastTime + this.loopTime);
          }
          this.time = this.timeRunning;
          this.scanForward();
          return;
        }
        this.playing = false;
      }
      if (!jumped) this.scanForward();
      return;
    }
    if (this.timeRunning < 0 || this.timeRunning < this.loopTime) {
      if (this.loopTime >= 0) {
        this.time = this.loopTime;
        this.scanBackward();
        if (!x64 && (this.syncStop || this.alignStop)) return;
        this.time = this.lastTime;
        this.resetFrames();
        if (!x64 && (this.syncStop || this.alignStop)) return;
        if (x64) {
          let value = this.timeRunning;
          if (value < this.loopTime) {
            if (this.lastTime - this.loopTime > 0)
              while (value < this.loopTime)
                value = Math.fround(Math.fround(value - this.loopTime) + this.lastTime);
            else value = this.lastTime;
          }
          this.timeRunning = value;
        } else {
          while (this.timeRunning < this.loopTime)
            this.timeRunning = Math.fround(this.timeRunning - this.loopTime + this.lastTime);
        }
        this.time = this.timeRunning;
        this.scanBackward();
        return;
      }
      this.time = this.timeRunning = 0;
      this.playing = false;
    }
    if (!jumped) this.scanBackward();
  }
}
