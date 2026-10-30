import {emoteBuild, EMOTEDRIVER_X64_SHA256} from '../../build.js';

const f32 = Math.fround;
const PI = f32(Math.PI);

/** Two-variable clamp: x86 0x1001bff0, x64 0x18001a660. */
export class EmoteVariableClamp {
  private readonly x64: boolean;
  private readonly min: number;
  private readonly max: number;
  private readonly type: number;
  private readonly output = new Float32Array(2);

  constructor(
    settings: {readonly min: number; readonly max: number; readonly type: number},
    driverSha256?: string,
  ) {
    this.x64 = emoteBuild(driverSha256) === EMOTEDRIVER_X64_SHA256;
    this.min = f32(settings.min);
    this.max = f32(settings.max);
    this.type = settings.type;
  }

  /** Borrowed pair, overwritten on the next call. Mirroring is applied by the player. */
  apply(lr: number, ud: number): Float32Array {
    const min = this.min;
    const range = this.x64 ? f32(this.max - min) : this.max - min;
    if (this.x64) {
      lr = f32(f32(f32(f32(lr - min) / range) * 2) - 1);
      ud = f32(f32(f32(f32(ud - min) / range) * 2) - 1);
    } else {
      lr = f32(((lr - min) / range) * 2 - 1);
      ud = f32(((ud - min) / range) * 2 - 1);
    }
    if (lr !== 0 && ud !== 0) {
      if (this.type === 0) {
        let r = Math.abs(f32(lr / ud));
        if (r > 1) r = f32(1 / r);
        const k = f32(1 / f32(Math.sqrt(this.x64 ? f32(f32(r * r) + 1) : f32(r * r + 1))));
        lr = f32(k * lr);
        ud = f32(k * ud);
        if (this.x64) {
          const len = f32(Math.sqrt(f32(f32(ud * ud) + f32(lr * lr))));
          const a = f32(Math.cos(f32(f32(r * PI) * 0.5)));
          const b = f32(Math.sin(f32(f32(len * PI) * 0.5)));
          const m = f32(f32(f32(1 - a) * f32(f32(b / len) - 1)) + 1);
          ud = f32(m * ud);
          lr = f32(m * lr);
        } else {
          const len = f32(Math.sqrt(f32(lr * lr + ud * ud)));
          const c1 = f32(1 - f32(Math.cos(f32(r * PI * 0.5))));
          const ratio = f32(f32(Math.sin(f32(len * PI * 0.5))) / len);
          const m = f32((ratio - 1) * c1 + 1);
          lr = f32(m * lr);
          ud = f32(m * ud);
        }
      } else if (this.type === 1) {
        const len = f32(
          Math.sqrt(this.x64 ? f32(f32(ud * ud) + f32(lr * lr)) : f32(lr * lr + ud * ud)),
        );
        if (len > 1) {
          const a = f32(Math.atan2(ud, lr));
          lr = f32(Math.cos(a));
          ud = f32(Math.sin(a));
        }
      }
    }
    this.output[0] = this.x64
      ? f32(f32(f32(f32(lr + 1) * 0.5) * range) + min)
      : f32((lr + 1) * 0.5 * range + min);
    this.output[1] = this.x64
      ? f32(f32(f32(f32(ud + 1) * 0.5) * range) + min)
      : f32(range * ((ud + 1) * 0.5) + min);
    return this.output;
  }
}
