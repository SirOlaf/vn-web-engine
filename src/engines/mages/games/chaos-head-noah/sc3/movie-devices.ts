import type {NoahTextures} from './textures.js';
import type {YuvFrame} from '../../../../../video/frame.js';
import type {NoahState} from './noah-state.js';

/** CRI boundary used by Noah's movie-device wrapper, not a shared VM behavior.
 * Handles are engine identities; a host must bind every non-null live handle.
 * Status is the result of the native 140162c10 query (0–7).
 * stop performs the synchronous 140163520 request, not device destruction. */
export interface NoahMovieHost {
  initialize?(channel: number): number;
  sample?(handle: number):
    | {
        status: number;
        positionMs: number;
        durationMs: number;
        frameCount: number;
        frameRate: number;
        frame?: import('../../../../../video/frame.js').YuvFrame;
      }
    | undefined;
  status(handle: number): number;
  stop(handle: number): void;
  /** File interfaces are per native stream record; open returns a native result code. */
  closeFile?(channel: number, stream: number): void;
  openFile?(channel: number, asset: number): number;
  start?(handle: number, asset: number): void;
  volume?(handle: number, gain: number): void;
  loop?(handle: number, enabled: boolean): void;
  pause?(handle: number, paused: boolean): void;
}

export class NoahMovieDevices {
  private readonly frames = new Map<number, YuvFrame>();
  constructor(
    readonly state: NoahState,
    private readonly host?: NoahMovieHost,
  ) {}
  /** 14001d560 initializes channel zero only. Other channels remain disabled. */
  initialize(): void {
    if (!this.host?.initialize) return;
    const s = this.state,
      b = this.base(0);
    s.put(b + 8, 0, 8);
    s.put(b + 0x10, 0x100);
    s.put(b + 0x14, 0, 2);
    s.put(b + 0x16, 0, 1);
    s.put(b + 0x18, 0x3f800000, 8);
    s.put(b + 0x20, 0);
    s.put(b + 0x24, -1, 8);
    s.put(b + 0x2c, -1, 8);
    for (const at of [0x38, 0x40, 0x48, 0x50, 0xcd8, 0xd70]) s.put(b + at, 0, 8);
    s.put(b + 0xce0, 0, 2);
    s.put(b + 0xce2, 0);
    s.zero(b + 0xce6, 8);
    s.zero(b + 0xcf0, 128);
    const handle = this.host.initialize(0);
    s.put(b + 0xdd8, handle, 8);
    s.put(b + 0xdd0, 2);
    s.put(b + 0xde0, this.host.status(handle));
    s.put(b + 0x34, 0);
    s.put(b + 8, 1, 1);
    s.put(b + 0xce6, 2, 2);
    s.put(b + 0xcf0, 0x141d2e1c0, 8);
    s.put(b + 0xcf8, 0x141d2e370, 8);
    s.put(0x1d2e1f2, 0, 1);
    s.put(0x1d2e3a2, 0, 1);
  }
  /** CRI metadata sampling and the movie block of 14001e4c0, before dispatch. */
  advance(textures?: NoahTextures): void {
    const s = this.state;
    for (let ch = 0; ch < 4; ch++) {
      const b = this.base(ch);
      if (!s.bytes(b + 8, 1)[0]) continue;
      const handle = Number(s.view(b + 0xdd8, 8).getBigUint64(0, true)),
        sample = this.host?.sample?.(handle);
      if (sample) {
        this.host?.volume?.(handle, s.view(b + 0x18, 4).getFloat32(0, true));
        this.refresh(ch);
        const frame = sample.frame;
        if (frame && s.bytes(b + 0xb, 1)[0] && frame !== this.frames.get(ch)) {
          const count = s.view(b + 0xce6, 2).getUint16(0, true);
          if (count === 0) continue;
          if (
            !(sample.frameRate > 0) ||
            !Number.isInteger(sample.frameCount) ||
            sample.frameCount < 1
          )
            throw new Error('Invalid decoded movie metadata');
          // 140073f10 / 140073ca0: a decoded picture, not merely an open stream,
          // publishes the display position and releases the script's ready wait.
          s.put(b + 0x38, frame.index, 8);
          s.put(b + 0x40, sample.frameCount, 8);
          s.put(b + 0x48, Math.floor((frame.index * 1000) / sample.frameRate), 8);
          s.put(b + 0x50, Math.floor((sample.frameCount * 1000) / sample.frameRate), 8);
          s.put(b + 0x1c, frame.width);
          s.put(b + 0x20, s.bytes(b + 0x15, 1)[0] ? Math.trunc(frame.height / 2) : frame.height);
          s.put(b + 0xce2, 0, 2);
          if (count) {
            const index = (s.view(b + 0xce4, 2).getUint16(0, true) + 1) % count;
            s.put(b + 0xce4, index, 2);
            s.put(b + 0xd70, 0, 8);
            if (s.bytes(b + 0x16, 1)[0]) {
              for (let i = 0; i < count; i++) {
                const pointer = Number(s.view(b + 0xcf0 + i * 8, 8).getBigUint64(0, true));
                if (!pointer) continue;
                const a = pointer - 0x140000000;
                if (s.bytes(a + 0x30, 1)[0]) {
                  s.put(a + 0x72, frame.width, 2);
                  s.put(a + 0x74, s.get(b + 0x20), 2);
                  s.put(a + 0x34, s.bytes(b + 0x14, 1)[0]!, 1);
                  s.put(a + 0x35, s.bytes(b + 0x15, 1)[0]!, 1);
                }
              }
              s.put(b + 0x16, 0, 1);
            }
            const pointer = Number(s.view(b + 0xcf0 + index * 8, 8).getBigUint64(0, true)),
              id = (pointer - 0x141d1b200) / 0x1b0;
            if (!Number.isInteger(id) || id < 0 || id >= 512)
              throw new Error(`Invalid native movie output surface 0x${pointer.toString(16)}`);
            if (textures) {
              const a = pointer - 0x140000000;
              if (!textures.resources.has(id)) textures.createRgba(id, 1920, 1080);
              s.put(a + 0x44, 0x112);
              s.put(a + 0x48, 1);
              s.put(a + 0x72, frame.width, 2);
              s.put(a + 0x74, s.get(b + 0x20), 2);
              s.put(a + 0x34, frame.alpha ? 1 : 0, 1);
              s.put(a + 0x35, s.bytes(b + 0x15, 1)[0]!, 1);
              s.put(a + 0x32, 1, 1);
              s.put(b + 0x14, frame.alpha ? 1 : 0, 1);
              s.put(b + 0x2c, 0x112);
              s.put(b + 0x30, 1);
            }
            this.frames.set(ch, frame);
            s.put(b + 0xd, 1, 1);
          }
        }
      }
    }
    const b = this.base(0);
    if (s.bytes(b + 0x10, 1)[0] && s.bytes(b + 0xb, 1)[0]) {
      s.flags[0xe7] = s.flags[0xe7]! & ~8;
      this.stop(0);
    }
    const frames = (a: number) =>
      Math.trunc(
        Math.fround(
          Math.fround(Math.fround(Number(s.view(a, 8).getBigInt64(0, true))) * 30) / 1000,
        ),
      ) | 0;
    const duration = frames(b + 0x50);
    if (duration !== 0 && !(s.get(0x5a6e50) & 8)) {
      const position = frames(b + 0x48) >>> 0;
      if (s.get(0x5a6e10) >>> 0 === position) {
        const count = (s.get(0x5a6e30) + 1) | 0;
        s.put(0x5a6e30, count);
        if (count >>> 0 > 8 && (duration - 1) >>> 0 <= position)
          s.flags[0xe7] = s.flags[0xe7]! & ~8;
      } else {
        s.put(0x5a6e30, 0);
        s.put(0x5a6e10, position);
      }
    }
  }
  frame(channel: number): import('../../../../../video/frame.js').YuvFrame | undefined {
    return this.frames.get(channel);
  }
  dispose(): void {
    for (let ch = 0; ch < 4; ch++) {
      const b = this.base(ch),
        handle = Number(this.state.view(b + 0xdd8, 8).getBigUint64(0, true));
      if (handle) this.host?.stop(handle);
    }
  }
  private base(channel: number): number {
    if (!Number.isInteger(channel) || channel < 0 || channel >= 4)
      throw new Error(`Invalid Noah movie device ${channel}`);
    return 0x1d8be20 + channel * 0x1258;
  }
  private call<K extends 'closeFile' | 'openFile' | 'start' | 'volume' | 'loop' | 'pause'>(
    name: K,
  ): NonNullable<NoahMovieHost[K]> {
    const method = this.host?.[name];
    if (!method) throw new Error(`Noah movie host does not provide ${name}`);
    return method.bind(this.host) as NonNullable<NoahMovieHost[K]>;
  }
  /** 140072f60: release each native stream, preserving record holes. */
  private closeFiles(channel: number): void {
    const s = this.state,
      b = this.base(channel),
      close = this.call('closeFile');
    close(channel, 0);
    for (let i = 1; i < s.get(b + 0xcd8); i++) close(channel, i);
    s.put(b + 0xcd8, 0);
    s.put(b + 9, 0, 1);
  }
  /** 140072c30 clears all four native output-surface groups. */
  private clearSurfaces(b: number): void {
    const s = this.state;
    for (let group = 0; group < 4; group++) {
      const count = s.view(b + 0xce6 + group * 2, 2).getUint16(0, true);
      for (let i = 0; i < count; i++) {
        const pointer = Number(s.view(b + 0xcf0 + group * 32 + i * 8, 8).getBigUint64(0, true));
        if (pointer) s.put((pointer >= 0x140000000 ? pointer - 0x140000000 : pointer) + 0x32, 0, 1);
      }
    }
  }
  /** Complete archive-ID start path: 140025da0 -> 140072e70 -> 1400734b0. */
  start(channel: number, asset: number, flags: number): void {
    this.frames.delete(channel);
    const s = this.state,
      b = this.base(channel),
      enabled = () => s.bytes(b + 8, 1)[0] !== 0;
    s.put(0x5a6e50 + channel * 4, flags);
    s.put(0x5a6e10 + channel * 4, 0);
    s.put(0x5a6e30 + channel * 4, 0);
    if (enabled()) {
      s.put(b + 0x12, flags & 8 ? 1 : 0, 1);
      if (s.bytes(b + 0xb, 1)[0]) this.stopPlayback(channel);
      if (s.bytes(b + 9, 1)[0]) {
        this.closeFiles(channel);
        s.put(b + 0x34, 0);
        s.put(b + 9, 0, 2);
      }
      this.closeFiles(channel);
      this.call('closeFile')(channel, 0);
      s.put(b + 0x74, 0x80000000);
      s.put(b + 0x1a8, 0x141c16b30, 8);
      s.put(b + 0x78, asset);
      s.put(b + 0x7c, 2);
      if (this.call('openFile')(channel, asset) === 0) s.put(b + 9, 1, 1);
      // Native intentionally starts even when the file-open result is an error.
      s.put(b + 0x34, 0);
      s.put(b + 9, 1, 2);
      s.put(b + 0xb, 0, 1);
      s.put(b + 0xd, 0);
      s.put(b + 0x1c, 0, 8);
      s.put(b + 0x24, -1, 8);
      s.put(b + 0x2c, -1, 8);
      s.put(b + 0x34, 1);
      s.put(b + 0x48, 0, 8);
      s.put(b + 0x50, 0, 8);
      this.clearSurfaces(b);
      s.put(b + 0x34, 2);
      s.put(b + 10, 1, 1);
      s.put(b + 0xb, 0, 1);
      s.put(b + 0xd, 0);
      s.put(b + 0x48, 0, 8);
      s.put(b + 0x50, 0, 8);
      this.clearSurfaces(b);
      s.put(b + 0x16, 1, 1);
      s.put(b + 0x34, 3);
      s.put(b + 0xb, 1, 1);
      s.put(b + 0xcd8, 0, 8);
      s.put(b + 0xce0, 0, 2);
      const handle = Number(s.view(b + 0xdd8, 8).getBigUint64(0, true));
      this.call('volume')(handle, s.view(b + 0x18, 4).getFloat32(0, true));
      this.call('loop')(handle, s.bytes(b + 0x12, 1)[0] !== 0);
      this.call('pause')(handle, s.bytes(b + 0xc, 1)[0] !== 0);
      this.call('start')(handle, asset);
      this.refresh(channel);
      s.put(b + 0x34, 3);
      s.put(b + 0xb, 1, 1);
    }
    if (enabled()) s.put(b + 0x14, flags & 4 ? 0x101 : 0, 2);
  }
  pause(channel: number, paused: boolean): void {
    const s = this.state,
      b = this.base(channel);
    if (!s.bytes(b + 8, 1)[0]) return;
    s.put(b + 0xc, paused ? 1 : 0, 1);
    this.call('pause')(Number(s.view(b + 0xdd8, 8).getBigUint64(0, true)), paused);
  }
  /** 1400737e0, including sticky flags and signed 64-bit position maxima. */
  refresh(channel: number): void {
    const s = this.state,
      b = this.base(channel);
    s.put(b + 0x34, 6);
    const handle = Number(s.view(b + 0xdd8, 8).getBigUint64(0, true));
    if (!s.bytes(b + 8, 1)[0] || !handle) return;
    s.put(b + 0xe, 0, 1);
    if (!this.host) throw new Error(`Unbound Noah movie handle ${handle}`);
    const status = this.host.status(handle);
    s.put(b + 0xde0, status);
    switch (status) {
      case 0:
        s.put(b + 0x34, 0);
        if (s.bytes(b + 0xf, 1)[0]) s.put(b + 0x10, 1, 1);
        break;
      case 1:
      case 2:
      case 3:
        s.put(b + 0x34, 1);
        break;
      case 4:
        s.put(b + 0x34, 2);
        s.put(b + 10, 1, 1);
        break;
      case 5:
        s.put(b + 0x34, 3);
        if (s.bytes(b + 0xd, 1)[0]) s.put(b + 0xe, 0x101, 2);
        break;
      case 6:
        s.put(b + 0x34, 4);
        s.put(b + 0x10, 1, 1);
        break;
      default:
        s.put(b + 0x10, 1, 1);
        break;
    }
    if (s.bytes(b + 0x10, 1)[0])
      for (const offset of [0x38, 0x48]) {
        const current = s.view(b + offset, 8),
          next = s.view(b + offset + 8, 8).getBigInt64(0, true);
        if (current.getBigInt64(0, true) < next) current.setBigInt64(0, next, true);
      }
  }
  /** 140025ee0 for channel 0; 140051029's separate channel-1 cleanup. */
  stop(channel: number): void {
    const s = this.state,
      b = this.base(channel);
    for (const a of [0x5a6e20, 0x5a6e60, 0x5a6e40]) s.put(a + channel * 4, 0);
    this.stopPlayback(channel);
  }
  private stopPlayback(channel: number): void {
    const s = this.state,
      b = this.base(channel);
    if (!s.bytes(b + 8, 1)[0]) return;
    this.refresh(channel);
    const status = s.get(b + 0xde0),
      handle = Number(s.view(b + 0xdd8, 8).getBigUint64(0, true));
    // 140163520 reports a null handle and returns without touching a decoder.
    if (status !== 0 && status !== 6 && handle) {
      if (!this.host) throw new Error(`Unbound Noah movie handle ${handle}`);
      this.host.stop(handle);
    }
    s.put(b + 0xb, 0, 1);
    if (s.bytes(b + 8, 1)[0]) s.put(b + 0x34, 0);
  }
}
