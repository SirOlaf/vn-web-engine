import type {AudioTransport, AudioVoice} from '../../../../../audio/transport.js';
import type {NoahState} from './noah-state.js';
import {mixAudio, spatialAudio} from './audio-mix.js';
const channelBase = (i: number) => {
  if (!Number.isInteger(i) || i < 0 || i >= 10) throw new Error(`Invalid audio channel ${i}`);
  return 0x5a7110 + i * 0x98;
};
const deviceBase = (i: number) => 0x1d90900 + i * 0x5218;
const positions = [0x3ac0, 0x3ac8, 0x3ae8, 0x3a90, 0x3aa0, 0x3ab0, undefined, 0x3a74];
const durations = [0x3b0c, 0x3b10, 0x3b14, 0x3b00, 0x3b04, 0x3b08];

/** Engine state controller (140027180), separate from the host audio device. */
export class NoahAudio {
  private readonly jobs = new Map<
    number,
    {promise: Promise<void>; voice?: AudioVoice; error?: unknown}
  >();
  private readonly voices = new Map<number, AudioVoice>();
  private disposed = false;
  constructor(
    readonly s: NoahState,
    readonly transport?: AudioTransport,
  ) {}
  private get(a: number) {
    return this.s.get(a);
  }
  private put(a: number, n: number, width = 4) {
    this.s.put(a, n, width);
  }
  private active(i: number) {
    return this.s.bytes(deviceBase(i) + 8, 1)[0] !== 0;
  }
  /** Boot-only device initialization followed by the native 1400285e0 reset. */
  initialize(): void {
    // 140026f50 -> 140075950, before the game-channel reset 1400285e0.
    const names = [
      'SE0',
      'SE1',
      'SE2',
      'VOICE0',
      'VOICE1',
      'VOICE2',
      'REV',
      'BGM0',
      'BGM1',
      'BGM2',
    ];
    for (let i = 0; i < 10; i++) {
      this.stop(i);
      const d = deviceBase(i);
      this.put(d + 8, 0, 2);
      this.put(d + 11, 0, 8);
      this.put(d + 0x13, 0);
      this.put(d + 0x18, 0x3f800000);
      this.put(d + 0x20, 0, 1);
      for (const at of [0x24, 0x2c, 0x38, 0x1d0, 0x1d8, 0x1e8, 0x1f8]) this.put(d + at, 0, 8);
      for (const at of [0x44, 0x48, 0x1e0, 0x1f0]) this.put(d + at, 0);
      this.s.bytes(d + 0x4c, names[i]!.length + 1).set(new TextEncoder().encode(names[i] + '\0'));
      this.put(d + 8, this.transport ? 1 : 0, 1);
    }
    this.reset();
  }
  /** Native 1400285e0; stops host voices and preserves holes in both record kinds. */
  reset(): void {
    for (let i = 0; i < 10; i++) {
      this.stop(i);
      const b = channelBase(i);
      this.put(0x5a70d8 + i * 4, 0);
      for (const at of [0, 0x14, 0x2c]) this.put(b + at, -1);
      for (const at of [4, 12, 0x18, 0x20, 0x38, 0x48, 0x50, 0x60, 0x68, 0x70, 0x90])
        this.put(b + at, 0, 8);
      for (const at of [0x28, 0x30, 0x40, 0x58]) this.put(b + at, 0);
    }
  }
  /** 140075ca0, including the 1400760a0 status/metadata refresh before stop. */
  stopDevice(i: number): void {
    channelBase(i);
    if (!this.active(i)) return;
    const d = deviceBase(i),
      voice = this.voices.get(i);
    this.put(d + 0x48, 6);
    if (voice) {
      const ended = voice.ended(),
        position = voice.position();
      this.put(d + 15, 0, 1);
      this.put(d + 0x208, ended ? 3 : 2);
      if (ended) this.put(d + 17, 1, 1);
      else this.put(d + 14, 0x101, 2);
      this.put(d + 0x28, voice.sampleRate);
      this.put(d + 0x24, voice.sampleCount);
      this.put(d + 0x1d8, Math.trunc((voice.sampleCount * 1000) / voice.sampleRate), 8);
      this.put(d + 0x38, position, 8);
      this.put(d + 0x1d0, Math.trunc((position * 1000) / voice.sampleRate), 8);
    } else if (this.s.view(d + 0x200, 8).getBigUint64(0, true) !== 0n)
      throw new Error(`Unbound Noah audio handle on device ${i}`);
    this.stop(i);
  }
  private stop(i: number): void {
    this.jobs.delete(i);
    this.voices.get(i)?.dispose();
    this.voices.delete(i);
    if (this.active(i)) {
      const d = deviceBase(i);
      this.put(d + 0x48, 0);
      this.put(d + 11, 0, 2);
    }
  }
  pause(i: number, paused: boolean): void {
    if (this.active(i)) {
      this.put(deviceBase(i) + 13, paused ? 1 : 0, 1);
      this.voices.get(i)?.pause(paused);
    }
  }
  resume(i: number): void {
    this.pause(i, false);
  }
  private volume(i: number, value: number): void {
    if (this.active(i)) {
      const gain = Math.min(1, Math.max(0, Math.fround(value) * 0.0078125));
      this.s.view(deviceBase(i) + 24, 4).setFloat32(0, gain, true);
      this.voices.get(i)?.volume(gain);
    }
  }
  private load(i: number): void {
    if (!this.active(i) || !this.transport) return;
    const b = channelBase(i),
      d = deviceBase(i),
      bank = i >= 7 ? 8 : i >= 3 ? 6 : 7,
      id = this.get(b + 0x14),
      loop = this.get(b + 0x18) !== 0;
    this.put(d + 19, loop ? 1 : 0, 1);
    this.put(d + 0x48, 0);
    this.put(d + 11, 0, 1);
    this.put(d + 9, 1, 1);
    this.put(d + 12, 0, 1);
    this.put(d + 14, 0);
    this.put(d + 0x1d0, 0, 8);
    this.put(d + 32, 0, 1);
    for (const off of [0x24, 0x2c, 0x38, 0x1d8]) this.put(d + off, 0, 8);
    this.put(d + 11, 0x101, 2);
    const job: {promise: Promise<void>; voice?: AudioVoice; error?: unknown} = {
      promise: Promise.resolve(),
    };
    this.jobs.set(i, job);
    job.promise = this.transport.prepare(bank, id, loop).then(
      (voice) => {
        if (this.disposed || this.jobs.get(i) !== job) voice.dispose();
        else job.voice = voice;
      },
      (e) => {
        job.error = e ?? new Error('Audio load rejected');
      },
    );
  }
  async settle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
  }
  /** Publish transport completion at a frame boundary, never inside an opcode. */
  publish(): void {
    for (const [i, job] of this.jobs) {
      if (job.error !== undefined) throw new Error(`Audio channel ${i} failed`, {cause: job.error});
      if (!job.voice) continue;
      const voice = job.voice,
        d = deviceBase(i);
      this.jobs.delete(i);
      this.voices.set(i, voice);
      this.put(d + 0x24, voice.sampleCount);
      this.put(d + 0x28, voice.sampleRate);
      this.put(d + 0x38, 0, 8);
      this.put(d + 0x1d8, Math.floor((voice.sampleCount * 1000) / voice.sampleRate), 8);
      this.put(d + 0x48, 2);
      voice.volume(this.s.view(d + 24, 4).getFloat32(0, true));
      voice.pause(this.s.bytes(d + 13, 1)[0] !== 0);
    }
    for (const [i, voice] of this.voices) {
      const d = deviceBase(i),
        position = voice.position(),
        ended = voice.ended();
      this.put(d + 0x38, position, 8);
      this.put(d + 0x1d0, Math.floor((position * 1000) / voice.sampleRate), 8);
      this.put(d + 0x48, ended ? 4 : 3);
      this.put(d + 0x208, ended ? 3 : 2);
      this.put(d + 15, 0, 1);
      if (ended) this.put(d + 17, 1, 1);
      else this.put(d + 14, 0x101, 2);
    }
  }
  private clear(i: number): void {
    const b = channelBase(i);
    this.stop(i);
    this.put(0x5a70d8 + i * 4, 0);
    this.put(b + 0x2c, -1);
    this.put(b + 0x14, -1);
    this.put(b + 0x20, 0);
    this.put(b + 0x38, 0, 8);
    this.put(b + 0x30, 0);
    this.put(b + 0x28, 0);
    const at = positions[i];
    if (at !== undefined) this.s.variables.setBigUint64(at, 0n, true);
  }
  /** One complete native controller tick; host metadata is sampled by publish(). */
  advance(): void {
    const s = this.s,
      v = s.variables,
      g = (a: number) => this.get(a),
      p = (a: number, n: number, w = 4) => this.put(a, n, w),
      vp = (a: number, n: number) => v.setUint32(a, n, true);
    mixAudio(s);
    for (let i = 0; i < 10; i++) {
      const b = channelBase(i),
        d = deviceBase(i),
        at = positions[i];
      let volume = 0;
      if (g(b + 0x6c) === 0) {
        p(b + 0x68, 0);
        p(b + 0x54, 0);
        p(b + 0x70, 0);
      } else {
        const max = (g(b + 0x6c) << 16) >>> 0;
        if (max < g(b + 0x70) >>> 0) p(b + 0x70, max);
      }
      spatialAudio(s, i);
      if (g(b + 0x38) !== 0) {
        if (g(b + 0x50) === 0) {
          if (g(b + 0x48) === 0) volume = (g(b + 0x6c) << 16) >>> 0;
          else {
            volume = (g(b + 0x70) + g(b + 0x4c)) >>> 0;
            const max = (g(b + 0x6c) << 16) >>> 0;
            if (max <= volume) {
              p(b + 0x48, 0);
              volume = max;
            }
          }
          p(b + 0x70, volume);
        } else {
          const current = g(b + 0x70) >>> 0;
          if (current === 0) {
            p(b + 0x50, 0);
            this.clear(i);
            volume = g(b + 0x70) >>> 0;
          } else {
            const step = g(b + 0x54) >>> 0;
            if (step < current && step !== 0) {
              volume = current - step;
              p(b + 0x70, volume);
            } else p(b + 0x70, 0);
          }
        }
        p(b + 0x68, volume >>> 16);
        this.volume(i, volume >>> 16);
      }
      const requested = g(b);
      if ((g(b + 0x2c) === requested && g(b + 12) !== 1) || g(b + 0x38) === 0) {
        if (g(b + 0x14) !== requested || g(b + 16) === 1) {
          if ([0, 2, 4, 6].includes(g(d + 0x48))) p(b + 0x20, 0);
          if (g(b + 0x20) !== 1 || g(b + 0x24) !== 0) {
            p(b + 0x18, g(b + 4));
            p(b + 0x1c, g(b + 8));
            p(b + 0x50, 0);
            p(b + 0x14, requested);
            p(b + 0x20, 1, 8);
            p(b + 12, 0, 8);
            p(b + 0x28, 0);
            this.volume(i, 0);
            this.stop(i);
            p(0x5a70d8 + i * 4, 0);
            if (g(b + 0x14) < 0) {
              p(b + 0x20, 0);
              p(b + 0x24, 1, 8);
              continue;
            }
            const start = g(b + 0x1c);
            this.load(i);
            p(0x5a70d8 + i * 4, start);
            this.pause(i, start === 0);
          }
        }
        if (g(b + 0x20) === 1 && g(b + 0x24) === 0 && [2, 3, 4, 5].includes(g(d + 0x48))) {
          const rate = g(d + 0x28),
            samples = g(d + 0x24);
          if (samples > 0 && rate === 0)
            throw new Error('Native audio sample rate division by zero');
          const frames = Math.trunc((samples * 60) / rate) | 0;
          if (samples > 0 && frames !== 0) {
            const durationMs = s.view(d + 0x1d8, 8).getBigInt64(0, true);
            p(b + 0x20, 0);
            p(b + 0x24, 1);
            p(b + 0x28, 1);
            p(b + 0x58, durationMs > 0n ? Number((durationMs * 60n) / 1000n) : 0);
            p(b + 0x2c, g(b + 0x14));
            p(b + 0x5c, rate);
            p(b + 0x60, frames);
            p(b + 0x64, 0);
            p(b + 0x38, 1, 8);
            if (g(b + 0x48) === 0) {
              const amount = g(b + 0x6c) >>> 0;
              p(b + 0x68, amount);
              p(b + 0x70, amount << 16);
              this.volume(i, amount);
            } else {
              p(b + 0x70, 0);
              p(b + 0x68, 0);
              this.volume(i, 0);
            }
          }
        }
        if (g(b + 0x38) === 1) {
          const rate = g(d + 0x28),
            samples = g(d + 0x24);
          if (samples > 0 && rate === 0) throw new Error('Native audio position division by zero');
          const frames = Math.trunc((samples * 60) / rate) | 0;
          if (samples > 0 && frames !== 0) {
            const position = s.view(d + 0x38, 8).getBigInt64(0, true);
            p(b + 0x60, frames);
            p(b + 0x64, Number((position * 60n) / BigInt(rate)));
            p(b + 0x5c, rate);
            if (at !== undefined) {
              if (durations[i] !== undefined) vp(durations[i]!, g(b + 0x58));
              vp(at, g(b + 0x60));
              vp(at + 4, g(b + 0x64));
            }
          }
          if (g(d + 0x48) === 4) {
            if (g(b + 0x5c) !== 0 && at !== undefined) {
              vp(at, g(b + 0x60));
              vp(at + 4, g(b + 0x64));
              if (i < 3) vp(0x435c + i * 4, 65535);
            }
            p(b + 0x3c, 1);
            p(b + 0x14, -1);
            p(b, -1);
            p(b + 0x2c, -1);
            p(b + 0x38, 0);
          }
        }
      } else if (g(b + 0x40) === 1) {
        p(b + 0x50, 0);
        this.clear(i);
      } else if (g(b + 0x50) === 0) {
        p(b + 0x50, 1);
        if (g(b + 0x48) === 0) p(b + 0x54, g(b + 0x68) << 12);
        else {
          p(b + 0x54, (g(b + 0x70) >>> 0) >>> 4);
          p(b + 0x48, 0, 8);
        }
      }
    }
    const pause = !!(s.flags[0x97]! & 1) && !(s.flags[0x97]! & 2);
    for (let i = 0; i < 10; i++) {
      if (i === 6 || i === 7) continue;
      const b = channelBase(i);
      if (
        (pause ? g(b + 0x38) === 1 && g(b + 0x40) === 0 : g(b + 0x40) === 1 && g(b + 0x44) === 0) &&
        g(0x5a70d8 + i * 4) !== 0
      )
        this.pause(i, pause);
    }
    const b = channelBase(g(0x20dde8) >>> 0),
      track = g(b + 0x2c);
    if (
      s.flags[0x9d]! & 1 &&
      g(b + 0x38) === 1 &&
      track === g(b + 0x14) &&
      track === g(b) &&
      track === v.getInt32(0x4358, true) &&
      g(0x5a76a0) === 1 &&
      g(0x5a7694) === g(0x5a767c) &&
      g(0x5a7694) === g(0x5a7668) &&
      g(0x5a7694) === v.getInt32(0x43ac, true)
    ) {
      s.flags[0x9d] = s.flags[0x9d]! & ~1;
      s.flags[0x137] = s.flags[0x137]! | 8;
      p(b + 0x38, 1, 8);
      p(b + 0x2c, g(b + 0x14));
      p(b + 0x40, 0);
      p(b + 0x48, 0, 8);
      p(0x5a7694, g(0x5a767c));
      p(0x5a76a0, 1, 8);
      p(0x5a76a8, 0, 8);
      p(0x5a76b0, 0, 8);
    }
  }
  dispose(): void {
    this.disposed = true;
    for (let i = 0; i < 10; i++) this.stop(i);
  }
}
