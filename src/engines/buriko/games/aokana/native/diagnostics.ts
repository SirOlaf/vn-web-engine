import type {AokanaBpThread} from '../bp/state.js';
import {listThreadModules} from '../bp/modules.js';

export interface AokanaBpWriteWatch {
  readonly threadId: number;
  readonly address: number;
  readonly size: number;
  readonly name: Uint8Array;
}

export interface AokanaBpWriteWatchNotice {
  readonly watch: AokanaBpWriteWatch;
  readonly thread: AokanaBpThread;
  readonly address: number;
  readonly size: number;
}

/** Native diagnostics remain title-local and observable to a host diagnostic presenter. */
export class AokanaBpDiagnostics {
  writeWatchEnabled = false;
  errorCode = 0;
  errorDetail: Uint8Array | null = null;
  private readonly watches: AokanaBpWriteWatch[] = [];

  constructor(private readonly reportWriteWatch: (notice: AokanaBpWriteWatchNotice) => void) {}

  registerWriteWatch(
    thread: AokanaBpThread,
    address: number,
    size: number,
    name: Uint8Array,
  ): boolean {
    size >>>= 0;
    if (size === 0) return false;
    this.watches.unshift({threadId: thread.id, address: address >>> 0, size, name: name.slice()});
    return true;
  }

  clearWriteWatches(): void {
    this.watches.length = 0;
  }

  /** 0x1400b9080 preserves module-name and message bytes until native text conversion. */
  formatThreadMessage(thread: AokanaBpThread, message: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    const text = (value: string): void => {
      chunks.push(new TextEncoder().encode(value));
    };
    const hex = (value: number, width = 8): string =>
      (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
    const opcode = thread.moduleMemory[thread.instructionStart];
    if (opcode === undefined)
      throw new RangeError('Aokana diagnostic instruction is outside module storage');
    let instruction = opcode;
    if ((opcode >= 0x7f && opcode <= 0xe0) || opcode === 0xff) {
      const secondary = thread.moduleMemory[thread.instructionStart + 1];
      if (secondary === undefined)
        throw new RangeError('Aokana diagnostic secondary byte is outside module storage');
      instruction = (opcode << 8) | secondary;
    }
    const modules = listThreadModules(thread, true);
    if (modules.length === 0) {
      text(
        `Thread [ ${thread.id | 0} ] , IP [ $${hex(thread.instructionStart)} ] , Instruction [ $${hex(instruction, 1)} ]\n\n`,
      );
    } else {
      const find = (address: number) => {
        for (const module of modules) if (address >= module.base) return module;
        throw new RangeError('Aokana diagnostic code address precedes every module');
      };
      const current = find(thread.instructionStart);
      text(`Thread [ ${thread.id | 0} ] , Program [ `);
      chunks.push(current.name);
      text(
        ` ] , SP [ $${hex(thread.frameCursor)} ]\nIP in program [ $${hex(thread.instructionStart - current.base)} ] , Instruction [ $${hex(instruction, 1)} ]\n`,
      );
      if (thread.interpreterNumber >= 0)
        text(`Interpreter Number [ ${thread.interpreterNumber | 0} ]\n`);
      text(`\nError Code [ $${hex(this.errorCode)} ]\n\n`);
      if (this.errorDetail !== null) {
        chunks.push(this.errorDetail);
        text('\n\n');
      }
      for (const site of thread.callSites) {
        const called = find(site);
        text('( ');
        chunks.push(called.name);
        text(` - $${hex(site - called.base)} )\n`);
      }
      if (thread.callSites.length !== 0) text('\n');
    }
    chunks.push(message);
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  /** 0x1400ee2d0 stops at the first overlap, even when its owner fails the later filter. */
  checkWrite(thread: AokanaBpThread, address: number, size: number): void {
    if (!this.writeWatchEnabled) return;
    address >>>= 0;
    size >>>= 0;
    const lastByte = (address + size - 1) >>> 0;
    const watch = this.watches.find(
      (entry) => entry.address <= lastByte && address < (entry.address + entry.size) >>> 0,
    );
    if (watch === undefined) return;
    const bank = address >>> 28;
    if (bank >= 1 && bank <= 3 && watch.threadId !== thread.id) return;
    this.reportWriteWatch({watch, thread, address, size});
  }
}
