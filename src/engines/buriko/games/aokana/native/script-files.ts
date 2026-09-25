import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaAsyncCriticalSection} from './async-critical-section.js';
import {AokanaNativeFile} from './native-file.js';
import {aokanaCompareNamedBytes} from './named-value-map.js';
import type {AokanaProgramFiles} from './program-files.js';
import {copyText, textBytes} from './text.js';

export interface AokanaScriptFileRecord {
  readonly id: number;
  readonly normalizedName: AokanaBpPointer;
  readonly file: AokanaNativeFile;
  readonly mode: number;
  busy: number;
  next: AokanaScriptFileRecord | null;
}
interface ScriptFileJob {
  readonly output: AokanaBpPointer | null;
  readonly id: number;
  readonly buffer: AokanaBpPointer | null;
  readonly count: number;
  readonly close: number;
  next: ScriptFileJob | null;
}

/** The one 1D0330 file registry, 1D0388 FIFO and distinct 1D0340 recursive section. */
export class AokanaScriptFiles {
  readonly section = new AokanaAsyncCriticalSection();
  private enabled = 0;
  private sectionLive = false;
  private closing = false;
  private counter = 0;
  private first: AokanaScriptFileRecord | null = null;
  private firstJob: ScriptFileJob | null = null;
  constructor(
    readonly files: AokanaProgramFiles,
    readonly actors: {readonly currentActor: object},
    readonly sleep: (milliseconds: number) => Promise<void>,
  ) {}

  /** 031C70 does not reset the ID counter or replace either live list. */
  initialize(): void {
    this.section.initialize();
    this.sectionLive = true;
    this.enabled = 1;
    this.closing = false;
  }
  get hasLiveSection(): boolean {
    return this.sectionLive;
  }
  get hasPending(): boolean {
    return this.firstJob !== null;
  }
  /** 0319E0 does not acquire the section itself. */
  find(id: number): AokanaScriptFileRecord | null {
    for (let record = this.first; record !== null; record = record.next)
      if (record.id === id >>> 0) return record;
    return null;
  }

  /** 031A10 normalizes only its duplicate-name copy and opens the original supplied name. */
  async open(
    output: AokanaBpPointer | null,
    path: AokanaBpPointer | null,
    mode: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    mode >>>= 0;
    if (mode > 2) return 0x80000001;
    await this.section.enter(actor);
    try {
      if (this.closing) throw new Error('Aokana script files are closing');
      const normalized = {bytes: new Uint8Array(784), offset: 0};
      copyText(normalized, path!);
      this.files.text.lowercase(normalized);
      for (let record = this.first; record !== null; record = record.next)
        if (aokanaCompareNamedBytes(normalized, record.normalizedName) === 0) return 0x80000002;
      const file = new AokanaNativeFile(this.files),
        opened =
          mode === 0 ? await file.openRead(path!) : await file.openWrite(path!, Number(mode === 2));
      if (opened === 0) {
        file.dispose();
        return 0x80000003;
      }
      this.counter = (this.counter + 1) >>> 0;
      const record: AokanaScriptFileRecord = {
        id: this.counter,
        normalizedName: {bytes: textBytes(normalized, true).slice(), offset: 0},
        file,
        mode,
        busy: 0,
        next: this.first,
      };
      this.first = record;
      pointerView(output!, 4).setUint32(0, record.id, true);
      return 0;
    } finally {
      this.section.leave(actor);
    }
  }

  /** 031960 unlinks before the concrete CFileDX destructor and does not alter the counter. */
  private remove(id: number): number {
    let previous: AokanaScriptFileRecord | null = null;
    for (let record = this.first; record !== null; record = record.next) {
      if (record.id === id >>> 0) {
        if (previous === null) this.first = record.next;
        else previous.next = record.next;
        record.file.dispose();
        return 0;
      }
      previous = record;
    }
    return 0x80000004;
  }

  /** 0318A0 retains both pointers and links the job before clearing a supplied completion DWORD. */
  private async enqueue(
    output: AokanaBpPointer | null,
    id: number,
    buffer: AokanaBpPointer | null,
    count: number,
    close: number,
    actor: object,
    shutdownClose = false,
  ): Promise<number> {
    await this.section.enter(actor);
    try {
      if (this.closing && !shutdownClose) throw new Error('Aokana script files are closing');
      if (this.find(id) === null) return 0x80000004;
      const job: ScriptFileJob = {
        output,
        id: id >>> 0,
        buffer,
        count: count >>> 0,
        close: close >>> 0,
        next: null,
      };
      let last = this.firstJob;
      if (last === null) this.firstJob = job;
      else {
        while (last.next !== null) last = last.next;
        last.next = job;
      }
      if (output !== null) pointerView(output, 4).setUint32(0, 0, true);
      return 0;
    } finally {
      this.section.leave(actor);
    }
  }
  queueClose(
    output: AokanaBpPointer | null,
    id: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.enqueue(output, id, null, 0, 1, actor);
  }
  queueTransfer(
    output: AokanaBpPointer | null,
    id: number,
    buffer: AokanaBpPointer | null,
    count: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.enqueue(output, id, buffer, count, 0, actor);
  }
  queueSeek(
    output: AokanaBpPointer | null,
    id: number,
    position: number,
    actor = this.actors.currentActor,
  ): Promise<number> {
    return this.enqueue(output, id, null, position, 0, actor);
  }

  /** 0316A0 consumes at most the live FIFO head; FD8D0 calls this after all higher-priority queues. */
  async processFirst(actor = this.actors.currentActor): Promise<number> {
    if (this.enabled === 0) return 0xffffffff;
    await this.section.enter(actor);
    let locked = true;
    try {
      const job = this.firstJob;
      if (job === null) return 1;
      const record = this.find(job.id);
      if (record === null) {
        if (job.output !== null) pointerView(job.output, 4).setUint32(0, 0xffffffff, true);
      } else if (job.close !== 0) {
        record.file.close();
        this.remove(job.id);
        if (job.output !== null) pointerView(job.output, 4).setUint32(0, 1, true);
      } else {
        record.busy = 1;
        this.section.leave(actor);
        locked = false;
        let transferred = 0;
        if (job.buffer !== null) {
          if (record.mode === 0) transferred = await record.file.read(job.buffer, job.count);
          else if (record.mode === 1 || record.mode === 2)
            transferred = await record.file.write(job.buffer, job.count);
        } else {
          const size = Number(BigInt.asUintN(32, record.file.size())),
            position = job.count === 0xffffffff ? size : job.count;
          if ((job.count === 0xffffffff || job.count <= size) && position !== 0xffffffff)
            transferred = Number(record.file.seekAbsolute(BigInt(position)));
        }
        await this.section.enter(actor);
        locked = true;
        record.busy = 0;
        pointerView(job.output!, 4).setUint32(
          0,
          transferred === 0 ? 0xffffffff : transferred,
          true,
        );
      }
      this.firstJob = job.next; // Reread after host work so jobs appended during that work remain linked.
      return 0;
    } finally {
      if (locked) this.section.leave(actor);
    }
  }

  /** 031BB0 queues real closes recursively, then yields while the shared worker drains them. */
  async shutdown(
    actor = this.actors.currentActor,
    workerRunning?: () => boolean,
    beforeDispose?: () => Promise<void>,
  ): Promise<void> {
    await this.section.enter(actor);
    try {
      if (this.closing) throw new Error('Aokana script files are already closing');
      this.closing = true;
      for (let record = this.first; record !== null; record = record.next)
        await this.enqueue(null, record.id, null, 0, 1, actor, true);
    } finally {
      this.section.leave(actor);
    }
    while (this.first !== null) {
      if (workerRunning !== undefined && !workerRunning())
        throw new Error('Aokana script close worker stopped before draining queued files');
      await this.sleep(1);
    }
    // Host recovery may empty the list while this close is asleep. That is not
    // successful FD8D0 consumption, even though the list is now empty.
    if (workerRunning !== undefined && !workerRunning())
      throw new Error('Aokana script close worker stopped before draining queued files');
    this.enabled = 0;
    if (beforeDispose !== undefined) await beforeDispose();
    this.section.dispose();
    this.sectionLive = false;
  }

  /** Host recovery after a failed shared worker has fully stopped and joined.
   * Native shutdown instead queues closes through the still-running worker. */
  async recoverAfterWorkerStop(actor = this.actors.currentActor): Promise<void> {
    if (!this.sectionLive) return;
    await this.section.enter(actor);
    let failed = false;
    let firstError: unknown;
    try {
      this.closing = true;
      this.firstJob = null; // No consumer remains for queued transfers or closes.
      while (this.first !== null) {
        const record = this.first;
        this.first = record.next;
        record.next = null;
        try {
          record.file.dispose();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
      this.enabled = 0;
    } finally {
      this.section.leave(actor);
      this.section.dispose();
      this.sectionLive = false;
    }
    if (failed) throw firstError;
  }
}
