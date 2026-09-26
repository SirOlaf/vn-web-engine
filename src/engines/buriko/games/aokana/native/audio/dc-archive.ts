import {pointerView, type AokanaBpPointer} from '../../bp/memory.js';
import {AokanaAsyncCriticalSection} from '../async-critical-section.js';
import {AokanaNativeFile} from '../native-file.js';
import type {AokanaProgramFiles} from '../program-files.js';

/** Actual default CRT LC_CTYPE: UTF-16 ASCII units only, no normalization. */
export function aokanaAudioWideLower(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    result += String.fromCharCode(unit >= 65 && unit <= 90 ? unit + 32 : unit);
  }
  return result;
}

/** 089BE0: count precedes both ordered qword/DWORD signature comparisons. */
export function validateAokanaDcArchiveHeader(header: AokanaBpPointer): number {
  const view = pointerView(header, 16),
    count = view.getUint32(12, true);
  if ((count - 1) >>> 0 > 0xffff) return 0x80000002;
  if (view.getBigUint64(0, true) === 0x45474758454e5548n && view.getUint32(8, true) === 0x30314146)
    return 0;
  if (view.getBigUint64(0, true) === 0x41204f4b49525542n && view.getUint32(8, true) === 0x30324352)
    return 0;
  return 0x80000002;
}
interface Entry {
  readonly offset: number;
  readonly size: number;
  live: boolean;
}
export interface AokanaDcArchiveInfo {
  readonly status: number;
  readonly offset?: number;
  readonly size?: number;
}

/** 08A720/08A3F0/089DE0: distinct raw DCArchive owner, not ProgramArchives. */
export class AokanaDcArchive {
  private readonly section = new AokanaAsyncCriticalSection();
  private readonly entries = new Map<string, Entry>();
  private path = '';
  private writeTime = 0n;
  private payloadBase: bigint | undefined;
  private disposed = false;
  constructor(readonly files: AokanaProgramFiles) {
    this.section.initialize();
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana DCArchive accesses released owner');
  }
  private clearEntries(): void {
    for (const entry of this.entries.values()) entry.live = false;
    this.entries.clear();
  }
  async openIndex(path: string, actor: object): Promise<number> {
    this.check();
    await this.section.enter(actor);
    const file = new AokanaNativeFile(this.files);
    try {
      if ((await file.openReadWide(path)) === 0) return 0x80000001;
      const time = await file.getWriteTime();
      if (time === null) return 0x80000000;
      const lower = aokanaAudioWideLower(path);
      if (lower === this.path && time === this.writeTime) return 0;
      const header = new Uint8Array(16),
        pointer = {bytes: header, offset: 0};
      if ((await file.read(pointer, 16)) !== 16) return 0x80000002;
      const status = validateAokanaDcArchiveHeader(pointer);
      if (status !== 0) return status;
      const count = new DataView(header.buffer).getUint32(12, true),
        index = new Uint8Array(count * 128);
      if ((await file.read({bytes: index, offset: 0}, count << 7)) !== count * 128)
        return 0x80000003;
      // Native publishes path/time/base before clearing and rebuilding the name tree.
      this.path = lower;
      this.writeTime = time;
      this.payloadBase = BigInt(count) * 128n + 16n;
      this.clearEntries();
      const view = new DataView(index.buffer);
      for (let i = 0; i < count; i++) {
        const offset = i * 128;
        const name = aokanaAudioWideLower(this.files.text.decodeAuto({bytes: index, offset}));
        const previous = this.entries.get(name);
        if (previous !== undefined) previous.live = false;
        this.entries.set(name, {
          offset: view.getUint32(offset + 96, true),
          size: view.getUint32(offset + 100, true),
          live: true,
        });
      }
      return 0;
    } finally {
      file.close();
      this.section.leave(actor);
    }
  }
  /** 08A100 copies metadata only after refreshing the same actual archive. */
  async memberInfo(name: string, actor: object): Promise<AokanaDcArchiveInfo> {
    this.check();
    await this.section.enter(actor);
    try {
      const status = await this.openIndex(this.path, actor);
      if (status !== 0) return {status};
      const entry = this.entries.get(aokanaAudioWideLower(name));
      return entry === undefined
        ? {status: 0x80000001}
        : {status: 0, offset: entry.offset, size: entry.size};
    } finally {
      this.section.leave(actor);
    }
  }
  /** 08A260 refresh and lookup; no detached resource decoding. */
  async hasMember(name: string, actor: object): Promise<number> {
    return (await this.memberInfo(name, actor)).status;
  }
  async readMember(
    destination: AokanaBpPointer,
    name: string,
    offset: number,
    count: number,
    actor: object,
    initialized?: Uint8Array,
  ): Promise<number> {
    this.check();
    offset >>>= 0;
    count >>>= 0;
    await this.section.enter(actor);
    let held = true;
    const file = new AokanaNativeFile(this.files);
    try {
      const status = await this.openIndex(this.path, actor);
      if (status !== 0) return status;
      const entry = this.entries.get(aokanaAudioWideLower(name));
      if (entry === undefined) return 0x80000001;
      const path = this.path;
      this.section.leave(actor);
      held = false;
      let retries = 5000;
      for (;;) {
        if ((await file.openReadWide(path)) !== 0) {
          // Native succeeds without transfer if open succeeds on the zero-counter iteration.
          if (retries === 0) return 0;
          try {
            if (!entry.live)
              throw new Error(
                'Aokana DCArchive consumes an entry invalidated while its section was released',
              );
            if (count === 0) count = entry.size;
            if (entry.size < count) return 0x80000005;
            if (entry.size < (count + offset) >>> 0) return 0x80000004;
            this.check();
            if (this.payloadBase === undefined)
              throw new Error('Aokana DCArchive reads unwritten payload base');
            file.seekAbsolute(this.payloadBase + BigInt(entry.offset) + BigInt(offset));
            return (await file.read(destination, count, initialized)) === count ? 0 : 0x80000003;
          } finally {
            // Explicit Close exists only inside the native nonzero-counter branch.
            file.close();
          }
        }
        if (file.lastError !== 5) return 0x80000000;
        if (retries === 0) return 0x80000006;
        // 09D9E0(1) requests0.5ms; browser timer precision is a selected scheduling profile.
        await new Promise<void>((resolve) => setTimeout(resolve, 0.5));
        retries--;
      }
    } finally {
      if (!held) {
        await this.section.enter(actor);
        held = true;
      }
      // Native destructor closes the zero-counter successful open after reacquiring.
      file.close();
      if (held) this.section.leave(actor);
    }
  }
  dispose(): void {
    this.check();
    this.section.dispose();
    this.clearEntries();
    this.disposed = true;
  }
}
