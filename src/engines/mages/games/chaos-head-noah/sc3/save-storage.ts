import {applyConfigPadBindings} from './config-state.js';
import type {NoahState} from './noah-state.js';
import type {FileSystem} from '../../../../../platform/filesystem.js';
import {NOAH_PATHS} from '../paths.js';
import {SYSTEM_SAVE, SYSTEM_SIZE, SLOT_BANK_SIZE} from './save-codec.js';
type Operation = 'check' | 'read' | 'write';
interface Request {
  operation: Operation;
  path: string;
  bytes: Uint8Array;
}
/** Native 1400762e0 / 14007b6d0, with file workers on the injected guest filesystem. */
export class SaveStorage {
  readonly buffer = new Uint8Array(SYSTEM_SIZE + SLOT_BANK_SIZE * 2);
  readonly configuration = new Uint8Array(0x94);
  /** SysFrame +1a6, set by 1400617c0 only when CONFIG.DAT cannot be opened. */
  configurationMissing = false;
  readonly events: {operation: Operation; path: string; status: number}[] = [];
  private request: Request | undefined;
  private job:
    | {
        promise: Promise<void>;
        done: boolean;
        published?: boolean;
        status: number;
        result: number;
        bytes?: Uint8Array;
      }
    | undefined;
  constructor(
    readonly state: NoahState,
    readonly files: FileSystem,
    readonly paths = NOAH_PATHS,
  ) {}
  async initializeConfiguration(): Promise<void> {
    this.configurationMissing = false;
    const config = this.configuration,
      v = new DataView(config.buffer);
    for (const [path, offset, size] of [
      [this.paths.config, 0, 0x6c],
      [this.paths.padConfig, 0x6c, 0x28],
    ] as const) {
      try {
        const source = await this.files.open(path);
        config.set(await source.read(0, Math.min(size, source.size)), offset);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'NOT_FOUND')) throw error;
        if (offset === 0) {
          this.configurationMissing = true;
          v.setUint32(0x2c, 720, true);
          v.setUint32(0x38, 2, true);
          v.setInt32(0x3c, 320, true);
          v.setInt32(0x40, 180, true);
        } else {
          v.setUint32(0x74, 0x03020100, true);
          v.setUint32(0x78, 0x05040607, true);
          config[0x7c] = 9;
          v.setUint16(0x7d, 0x0b0a, true);
        }
      }
    }
    applyConfigPadBindings(this.state, config);
  }
  private byte(a: number): number {
    return this.state.bytes(a, 1)[0]!;
  }
  start(operation: Operation, path = this.paths.saveData, bytes = this.buffer): void {
    const s = this.state;
    this.request = {operation, path, bytes};
    this.job = undefined;
    s.put(0x1bb037b, 1, 1);
    s.put(0x1bb0379, 0, 1);
    s.put(0x1bb037a, operation === 'check' ? 0x20 : operation === 'read' ? 0x10 : 0, 1);
    s.put(0x1bb037c, 0);
    s.put(0x1bb0383, 0, 1);
    s.put(0x1de8bb4, 1);
  }
  private worker(): void {
    const request = this.request;
    if (!request) throw new Error('Storage worker without a request');
    const job = {promise: Promise.resolve(), done: false, status: 0, result: 0} as NonNullable<
      SaveStorage['job']
    >;
    this.job = job;
    job.promise = (async () => {
      let opened = false;
      try {
        if (request.operation === 'write') {
          await this.files.commit([
            {kind: 'write', path: request.path, data: request.bytes.slice()},
          ]);
        } else {
          const source = await this.files.open(request.path);
          opened = true;
          if (request.operation === 'read')
            job.bytes = await source.read(0, Math.min(source.size, request.bytes.length));
        }
      } catch (error) {
        job.status =
          request.operation === 'write'
            ? error instanceof Error &&
              'code' in error &&
              ['READ_ONLY', 'NOT_DIRECTORY', 'IS_DIRECTORY', 'INVALID_PATH', 'NOT_FOUND'].includes(
                String(error.code),
              )
              ? 2
              : 4
            : opened
              ? 7
              : 2;
        job.result = 0x80000000;
      }
      job.done = true;
    })();
  }
  async settle(): Promise<void> {
    await this.job?.promise;
  }
  /** Called once at the host frame boundary; transport callbacks never write VM state. */
  advance(): void {
    const s = this.state,
      phase = s.get(0x1de8bb4),
      job = this.job;
    if (job?.done && !job.published) {
      job.published = true;
      if (job.bytes) {
        this.request!.bytes.set(job.bytes);
        job.bytes = undefined;
      }
      s.put(0x1bb037c, job.status);
      if (job.status) s.put(0x1bb0384, job.status === 2 ? -1 : -2);
    }
    switch (phase) {
      case 1:
        s.put(0x1bb037c, 0);
        s.put(0x1de8bb4, 4);
        break;
      case 4:
        this.worker();
        s.put(0x1de8bb4, 5);
        break;
      case 5:
        if (job?.done) {
          const status = s.get(0x1bb037c);
          if (status === 0) s.put(0x1de8bb4, this.request!.operation === 'check' ? 24 : 7);
          else if ([2, 4, 7].includes(status)) s.put(0x1de8bb4, 24);
        }
        break;
      case 7:
        s.put(0x1de8bb4, 13);
        break;
      case 13:
        this.worker();
        s.put(0x1de8bb4, 15);
        break;
      case 15:
        if (job?.done) {
          s.put(0x1bb037c, job.result);
          s.put(0x1de8bb4, job.result === 4 ? 20 : 17);
        }
        break;
      case 17:
        s.put(0x1de8bb4, 24);
        break;
      case 24:
        s.put(0x1bb0383, 1, 1);
        s.put(0x1de8bb4, 0);
        this.events.push({
          operation: this.request!.operation,
          path: this.request!.path,
          status: s.get(0x1bb037c),
        });
        this.job = undefined;
        break;
    }
  }
  poll(kind: 'check' | 'read' | 'write'): number {
    const s = this.state,
      guard = kind === 'check' ? 0x1de9cd0 : kind === 'read' ? 0x1de9cc8 : 0x1de9ccc;
    if (s.get(guard) !== 1) return 1;
    if (!this.byte(0x1bb037b) || this.byte(0x1bb0379))
      throw new Error('Native storage poll reads an uninitialized result after consumption');
    if (!this.byte(0x1bb0383)) return 1;
    s.put(0x1bb0379, 1, 1);
    if (kind === 'read') this.unpackBuffers();
    const status = s.get(0x1bb037c);
    return status === 0
      ? 0
      : status === 2 && kind !== 'write'
        ? 2
        : (({3: 5, 4: 4, 5: 3, 7: 255, 8: 6} as Record<number, number>)[status] ?? 100);
  }
  begin(kind: 'check' | 'read' | 'write'): number {
    this.state.put(kind === 'check' ? 0x1de9cd0 : kind === 'read' ? 0x1de9cc8 : 0x1de9ccc, 1);
    if (kind === 'write') this.packBuffers();
    this.start(kind);
    return 1;
  }
  private packBuffers(): void {
    let offset = 0;
    for (const [address, length] of [
      [SYSTEM_SAVE, SYSTEM_SIZE],
      [0xc4dc10, SLOT_BANK_SIZE],
      [0x873290, SLOT_BANK_SIZE],
    ]) {
      for (let i = 0; i < length!;) {
        const region = this.state.regions.find(
          (r) => address! + i >= r.address && address! + i < r.address + r.bytes.length,
        );
        if (!region) throw new Error('Unmapped save buffer');
        const n = Math.min(length! - i, region.address + region.bytes.length - address! - i);
        this.buffer.set(this.state.bytes(address! + i, n), offset + i);
        i += n;
      }
      offset += length!;
    }
  }
  private unpackBuffers(): void {
    let offset = 0;
    for (const [address, length] of [
      [SYSTEM_SAVE, SYSTEM_SIZE],
      [0xc4dc10, SLOT_BANK_SIZE],
      [0x873290, SLOT_BANK_SIZE],
    ]) {
      for (let i = 0; i < length!;) {
        const region = this.state.regions.find(
          (r) => address! + i >= r.address && address! + i < r.address + r.bytes.length,
        );
        if (!region) throw new Error('Unmapped save buffer');
        const n = Math.min(length! - i, region.address + region.bytes.length - address! - i);
        this.state.bytes(address! + i, n).set(this.buffer.subarray(offset + i, offset + i + n));
        i += n;
      }
      offset += length!;
    }
  }
  /** 140061af0 blocks its caller while the same service writes each config file. */
  async writeConfiguration(): Promise<void> {
    for (const [path, bytes] of [
      [this.paths.config, this.configuration.subarray(0, 0x6c)],
      [this.paths.padConfig, this.configuration.subarray(0x6c)],
    ] as const) {
      this.start('write', path, bytes);
      while (this.state.get(0x1de8bb4)) {
        await this.settle();
        this.advance();
      }
      this.state.put(0x1bb0379, 1, 1);
    }
  }
}
