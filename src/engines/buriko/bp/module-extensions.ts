import type {BurikoBpOpcodeContext, BurikoBpModuleResourceSource} from '../native/types.js';
import {readU8} from './decode.js';
import {BURIKO_BP_MODULE_NO_SPACE, attachModule, detachLastModule} from './modules.js';
import {pop32, readFrame32, setPc, writeFrame32} from './state.js';
import type {BurikoBpPointer} from './memory.js';

interface ExtensionResource {
  readonly name: Uint8Array;
  readonly module: Uint8Array;
}

/** Constructs the native FF trampoline from its documented instructions and module header. */
function mediationModule(): Uint8Array {
  const bytes = new Uint8Array(0x20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x10, true);
  view.setUint32(4, 0x10, true);
  // 06 +i16(16): push opcode-relative target; 16: call; FF F8: detach pair and return.
  bytes.set([0x06, 0x10, 0x00, 0x16, 0xff, 0xf8], 0x10);
  return bytes;
}

function readName(pointer: BurikoBpPointer | null, nullable = false): Uint8Array | null {
  if (pointer === null) {
    if (nullable) return null;
    throw new Error('Buriko module extension dereferenced a null resource name');
  }
  const end = pointer.bytes.indexOf(0, pointer.offset);
  if (end < 0) throw new RangeError('Unterminated Buriko module extension resource name');
  return pointer.bytes.subarray(pointer.offset, end);
}

/** The FF registry is shared across threads, distinct from fixed secondary opcode tables. */
export class BurikoBpModuleExtensions {
  private readonly resources = new Map<number, ExtensionResource>();

  constructor(private readonly source: BurikoBpModuleResourceSource) {}

  unregister(index: number): boolean {
    this.validateIndex(index);
    return this.resources.delete(index);
  }

  register(
    index: number,
    archiveName: Uint8Array | null,
    resourceName: Uint8Array,
    actor?: object,
  ): boolean | Promise<boolean> {
    this.unregister(index);
    // Native replacement deletes the old entry before attempting the resource read.
    const module = this.source.readModule(archiveName, resourceName, undefined, actor);
    const finish = (bytes: Uint8Array | null): boolean => {
      if (bytes === null || bytes.length === 0) return false;
      this.resources.set(index, {name: resourceName.slice(), module: bytes.slice()});
      return true;
    };
    return module instanceof Promise ? module.then(finish) : finish(module);
  }

  execute(context: BurikoBpOpcodeContext): 0 | Promise<0> {
    const {thread} = context;
    const secondary = readU8(thread);
    if (secondary === 0xf0) {
      const resourcePointer = context.memory.resolve(thread, pop32(thread));
      const archivePointer = context.memory.resolve(thread, pop32(thread));
      const index = pop32(thread);
      this.validateIndex(index);
      const resourceName = readName(resourcePointer)!;
      const archiveName = readName(archivePointer, true);
      const finish = (registered: boolean): 0 => {
        if (!registered)
          throw new Error(`Buriko module extension resource load failed for slot ${index}`);
        return 0;
      };
      const registered = this.register(index, archiveName, resourceName, context.actor);
      return typeof registered === 'boolean' ? finish(registered) : registered.then(finish);
    }
    if (secondary === 0xf1) {
      this.unregister(pop32(thread));
      return 0;
    }
    if (secondary === 0xf8) {
      // Both detaches occur even if the first fails; native ignores their return values.
      detachLastModule(thread);
      detachLastModule(thread);
      thread.frameCursor = (thread.frameCursor - 4) >>> 0;
      setPc(thread, readFrame32(thread, thread.frameCursor));
      return 0;
    }
    this.validateIndex(secondary);
    const entry = this.resources.get(secondary);
    if (entry === undefined) throw new Error(`Unregistered Buriko module extension ${secondary}`);
    const base = attachModule(thread, 'Mediation program', mediationModule());
    if (base === BURIKO_BP_MODULE_NO_SPACE)
      throw new Error('Buriko module extension mediation does not fit');
    if (attachModule(thread, entry.name, entry.module) === BURIKO_BP_MODULE_NO_SPACE) {
      // Native fatal path leaves the first attachment in place.
      throw new Error(`Buriko module extension ${secondary} does not fit`);
    }
    if (thread.frameCursor + 4 > thread.frameLimit)
      throw new RangeError('Buriko module extension frame overflow');
    writeFrame32(thread, thread.frameCursor, (thread.instructionStart + 2) >>> 0);
    thread.frameCursor = (thread.frameCursor + 4) >>> 0;
    setPc(thread, base);
    return 0;
  }

  clear(): void {
    this.resources.clear();
  }

  private validateIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= 0xf0) {
      throw new RangeError(`Invalid Buriko module extension ${index}`);
    }
  }
}
