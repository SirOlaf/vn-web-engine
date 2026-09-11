import {
  initializeApplicationState,
  initializeMovieState,
  initializeDisplaySettings,
} from './application-init.js';
import {compositionByte} from './composition-resources.js';
import {awardNoahAchievement} from './achievements.js';
import {RawAssets} from './raw-assets.js';
import {NoahMovieDevices, type NoahMovieHost} from './movie-devices.js';
import {NoahAudio} from './audio.js';
import {SceneText} from './scene-text.js';
import type {AudioTransport} from '../../../../../audio/transport.js';
import {NoahTips} from './tips.js';
import {MessageBoxes} from './message-boxes.js';
import {SaveStorage} from './save-storage.js';
import {TipsText} from './tips-text.js';
import {updateFrame} from './frame-update.js';
import {NoahInput} from './input.js';
import {StoredAchievements} from '../../../../../platform/achievements.js';
import {NOAH_GAME_ID} from '../identity.js';
import type {PlatformServices} from '../../../../../platform/services.js';
import {checkRange} from '../../../../../core/binary.js';
import {Sc3Script, MesScript} from './script.js';
import {Sc3Expressions} from './expression.js';
import type {ExpressionHost} from './expression.js';
import {NoahState} from './noah-state.js';
import {NoahTextures} from './textures.js';
import {TextureLoader} from './texture-load.js';
import type {TextureAssets} from './texture-load.js';
import {scriptLoad, LOAD_BUSY} from './script-load.js';
import type {ScriptBank, ScriptBufferHost} from './script-load.js';
import {opcodeGroups} from './opcodes/index.js';
import {BacklogText} from './backlog-text.js';
import type {OpcodeExecution} from './opcodes/types.js';
import {languageCode, languageSetting, type NoahLanguage} from './opcodes/language.js';

export interface Sc3Assets {
  manualPageCount?: () => number;
  movies?: NoahMovieHost;
  audio?: AudioTransport;
  textures?: TextureAssets;
  /** Absent means no audio device, matching the native disabled-channel path. */
  sound?: (id: number, volume: number) => void;
  size(bank: ScriptBank, id: number): number;
  script(id: number): Promise<Uint8Array>;
  messages(id: number): Promise<Uint8Array>;
  /** Mirrors the native MES/system/background/manual/movie archive selectors. */
  selectLanguage?(language: NoahLanguage): void;
}
export interface Sc3Options {
  /** Explicit host source: the interpreter consumes native rand() calls in native order. */
  random15(): number;
  /** Omit to restore the language field from CONFIG.DAT. */
  language?: NoahLanguage;
  /** Override the native missing-CONFIG flag for deterministic research fixtures. */
  configEnabled?: boolean;
  localTime?: () => Date;
  /** Undefined retains the full offline trace; live players keep a bounded recent tail. */
  traceLimit?: number;
}
export interface Sc3Trace {
  context: number;
  slot: number;
  asset: number;
  pc: number;
  bytes: string;
  operation: string;
  nextPc: number;
  result: number;
  yielded: boolean;
}
export class Sc3Fault extends Error {
  constructor(
    readonly context: number,
    readonly slot: number,
    readonly asset: number,
    readonly pc: number,
    readonly bytes: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `SC3 context ${context}, slot ${slot}, asset ${asset}, PC 0x${pc.toString(16)} [${bytes}]: ${reason}`,
      options,
    );
    this.name = 'Sc3Fault';
  }
}

const POOL = 0x17a2f00,
  GROUPS = 0x17a0dd0,
  NATIVE_BASE = 0x140000000;
// Script pointers are virtual identities. No host pointer or host file path enters VM state.
const scriptBase = (slot: number) => 0x200000000 + slot * 0x1000000;

/** Boot-driven interpreter. Only complete native handlers are registered below. */
export class Sc3Runtime {
  readonly movies: NoahMovieDevices;
  readonly sceneText: SceneText;
  readonly audio: NoahAudio;
  readonly state: NoahState;
  readonly expressions: Sc3Expressions;
  readonly textures: NoahTextures;
  readonly tips: NoahTips;
  readonly messageBoxes: MessageBoxes;
  readonly storage: SaveStorage;
  private hostBlock:
    {promise: Promise<void>; done: boolean; finish: () => void; error?: unknown} | undefined;
  readonly tipsText: TipsText;
  readonly input: NoahInput;
  readonly achievements: StoredAchievements;
  private readonly backgroundLoader: TextureLoader;
  readonly textureLoader: TextureLoader;
  readonly backlog: BacklogText;
  readonly rawAssets: RawAssets;
  readonly characterAssets: RawAssets;
  readonly scripts: (Sc3Script | undefined)[] = Array(16);
  readonly messages: (MesScript | undefined)[] = Array(16);
  readonly trace: Sc3Trace[] = [];
  private freeHead: number | undefined;
  private started = false;
  private exitRequest = false;
  private exited = false;
  get exitRequested(): boolean {
    return this.exitRequest;
  }
  private fault: Sc3Fault | undefined;
  private readonly code = new Map<number, Sc3Script>();
  private readonly messageBuffers = new Map<number, Uint8Array>();
  private nextBuffer = 0x300000000;
  private readonly jobs = new Map<
    number,
    {
      bank: ScriptBank;
      slot: number;
      address: number;
      asset: number;
      size: number;
      promise: Promise<void>;
      bytes?: Uint8Array;
      error?: unknown;
    }
  >();
  private frameIndex: number | undefined;
  private currentLanguage: NoahLanguage = 0;
  // Native dispatcher calls made by spawn are separate from SC3 call/return stacks.
  // Keep these continuations explicit so a debug budget can stop inside any child.
  private readonly dispatch: {id: number; finish?: () => void}[] = [];
  constructor(
    readonly platform: PlatformServices,
    readonly assets: Sc3Assets,
    readonly options: Sc3Options,
  ) {
    this.state = new NoahState(options.random15);
    this.movies = new NoahMovieDevices(this.state, assets.movies);
    this.audio = new NoahAudio(this.state, assets.audio);
    this.rawAssets = new RawAssets(this.state, assets.textures);
    this.characterAssets = new RawAssets(this.state, assets.textures, 1);
    this.storage = new SaveStorage(this.state, platform.windowsFiles);
    this.textures = new NoahTextures(this.state);
    this.textureLoader = new TextureLoader(this.state, this.textures, assets.textures);
    this.backgroundLoader = new TextureLoader(this.state, this.textures, assets.textures, 0);
    const scratch = this.state.bytes(0x586a60, 256 * 20);
    this.expressions = new Sc3Expressions(new Int32Array(scratch.buffer, scratch.byteOffset, 1280));
    this.input = new NoahInput(this.state);
    this.achievements = new StoredAchievements(platform.hostState, NOAH_GAME_ID);
    const textHost = {
      byte: (address: number) => this.dataByte(address),
      message: (slot: number, id: number) => this.messageAddress(slot, id),
      expression: (address: number) => this.textExpression(address),
    };
    this.tipsText = new TipsText(this.state, textHost);
    this.backlog = new BacklogText(this.state, textHost);
    this.sceneText = new SceneText(this.state, textHost);
    this.messageBoxes = new MessageBoxes(this.state, {
      ...textHost,
      hit: (g, i, a) => this.input.hit(g, i, a),
      sound: (id, volume) => this.assets.sound?.(id, volume),
    });
    this.tips = new NoahTips(this.state, {
      ...textHost,
      layout: (address) => this.tipsText.render(address),
      hit: (group, index, activate) => this.input.hit(group, index, activate),
      sound: (id, volume) => this.assets.sound?.(id, volume),
      achievement: (id) => awardNoahAchievement(this.achievements, id),
    });
  }
  get language(): NoahLanguage {
    return this.currentLanguage;
  }
  private selectLanguage(language: NoahLanguage): void {
    this.currentLanguage = language;
    this.assets.selectLanguage?.(language);
  }
  dataByte(address: number): number {
    const geometry = compositionByte(this.state, address);
    if (geometry !== undefined) return geometry;
    const companion = this.characterAssets.byte(address);
    if (companion !== undefined) return companion;
    for (const [base, script] of this.code)
      if (address >= base && address < base + script.bytes.length) return script.u8(address - base);
    for (const [base, bytes] of this.messageBuffers)
      if (address >= base && address < base + bytes.length) return bytes[address - base]!;
    const raw = this.rawAssets.byte(address);
    if (raw !== undefined) return raw;
    throw new Error(`Unmapped script/message data pointer 0x${address.toString(16)}`);
  }
  messageAddress(slot: number, id: number): number {
    const base = this.slotAddress('messages', slot),
      bytes = this.messageBuffers.get(base);
    if (!bytes) throw new Error(`Unloaded message slot ${slot}`);
    const message = this.messages[slot];
    if (!message) throw new Error(`Missing message index for slot ${slot}`);
    const index = message.byId.get(id);
    if (index === undefined) throw new Error(`Missing MES ID ${id} in slot ${slot}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset = (view.getUint32(12, true) + view.getUint32(20 + index * 8, true)) >>> 0;
    checkRange(bytes.length, offset, 1);
    return base + offset;
  }
  textExpression(
    address: number,
    readByte: (address: number) => number = (a) => this.dataByte(a),
  ): {value: number; next: number} {
    let next = address;
    const local = new Map<number, number>(),
      s = this.state;
    const value = this.expressions.evaluate({
      byte: () => readByte(next++),
      readVariable: (i) => s.variable(i),
      writeVariable: (i, v) => s.setVariable(i, v),
      readFlag: (i) => s.flag(i),
      writeFlag: (i, v) => s.setFlag(i, v),
      readContext: (handle, index) => {
        if (handle !== undefined)
          return this.context(handle & 0x7fffffff).getInt32(index * 4, true);
        if (!local.has(index))
          throw new Error(`Text expression reads uninitialized native local context word ${index}`);
        return local.get(index)!;
      },
      writeContext: (handle, index, v) => {
        if (handle === undefined) local.set(index, v);
        else this.context(handle & 0x7fffffff).setInt32(index * 4, v, true);
      },
      readScript: (slot, offset) => {
        if (slot === undefined) {
          const value = local.get(0x74 / 4);
          if (value === undefined)
            throw new Error('Text expression reads uninitialized native local script slot');
          slot = value;
        }
        const script = this.code.get(this.slotAddress('script', slot));
        if (!script) throw new Error(`Unloaded text-expression script slot ${slot}`);
        return script.u32(offset) | 0;
      },
      inputPressed: s.get(0x5a70d4),
      inputHeld: s.get(0x5a70d0),
      random15: this.options.random15,
    });
    return {value, next};
  }
  context(id: number): DataView {
    checkRange(100, id, 1);
    return this.state.view(POOL + id * 0x160, 0x160);
  }
  private pointer(rva: number, target: number | undefined): void {
    this.state.put(rva, target === undefined ? 0 : NATIVE_BASE + target, 8);
  }
  private initializeContexts(): void {
    this.state.zero(POOL, 100 * 0x160);
    for (let i = 0; i < 100; i++) {
      this.context(i).setInt32(0x70, i, true);
      this.pointer(POOL + i * 0x160 + 0x150, i < 99 ? POOL + (i + 1) * 0x160 : undefined);
    }
    this.freeHead = 0;
    for (let group = 0; group < 12; group++) {
      const head = GROUPS + group * 0x2c0,
        tail = head + 0x160;
      this.pointer(head + 0x140, undefined);
      this.pointer(head + 0x148, tail);
      this.pointer(tail + 0x140, head);
      this.pointer(tail + 0x148, undefined);
      this.state.put(0x17ab880 + group * 4, 0x20000000);
      this.state.put(0x17ab8b0 + group * 4, 0);
    }
  }
  /** 14005ee50. Allocation itself does not write group at +14; callers do. */
  allocateContext(group: number): number {
    checkRange(12, group, 1);
    const id = this.freeHead;
    if (id === undefined) throw new Error('SC3 context pool exhausted');
    const address = POOL + id * 0x160,
      c = this.context(id);
    const next = Number(c.getBigUint64(0x150, true));
    this.freeHead = next ? (next - NATIVE_BASE - POOL) / 0x160 : undefined;
    this.state.zero(address, 0x160);
    c.setUint32(0x70, id, true);
    c.setUint32(0x28, 65535, true);
    const tail = GROUPS + group * 0x2c0 + 0x160;
    const previous = Number(this.state.view(tail + 0x140, 8).getBigUint64(0, true)) - NATIVE_BASE;
    this.pointer(address + 0x140, previous);
    this.pointer(address + 0x148, tail);
    this.pointer(previous + 0x148, address);
    this.pointer(tail + 0x140, address);
    this.state.put(0x17ab8b0 + group * 4, this.state.get(0x17ab8b0 + group * 4) + 1);
    return id;
  }
  async boot(): Promise<number> {
    if (this.started) throw new Error('Create a new runtime to boot again');
    this.started = true;
    await this.achievements.load();
    // 14001d770 initializes the text clock multiplier before 14005f920.
    this.state.put(0x17abc0c, 1);
    this.state.initialize();
    await this.storage.initializeConfiguration();
    const configured = new DataView(
      this.storage.configuration.buffer,
      this.storage.configuration.byteOffset,
      this.storage.configuration.byteLength,
    ).getUint32(0x48, true);
    this.selectLanguage(this.options.language ?? languageCode(configured));
    this.textures.initializeRenderTargets();
    this.state.put(0x17ac318, languageSetting(this.currentLanguage));
    this.state.put(0x1badfbc, this.currentLanguage);
    initializeApplicationState(this.state);
    initializeMovieState(this.state);
    this.movies.initialize();
    this.audio.initialize();
    this.initializeContexts();
    // 1400515f0 -> 140065bd0 explicitly opens archive ID 1 in groups 3 and 4.
    const script = new Sc3Script(1, await this.assets.script(1));
    const messages = new MesScript(await this.assets.messages(1));
    this.scripts[0] = script;
    this.messages[0] = messages;
    this.code.set(scriptBase(0), script);
    this.messageBuffers.set(0x280000000, messages.bytes);
    this.state.put(0x17adcb0, scriptBase(0), 8);
    this.state.put(0x17abc10, 0x280000000, 8);
    this.state.put(0x20ddf0, 1);
    const id = this.allocateContext(0);
    this.context(id).setUint32(0x74, 0, true);
    this.context(id).setBigUint64(0x158, BigInt(scriptBase(0) + script.label(0)), true);
    initializeDisplaySettings(this.state, this.storage.configuration);
    return id;
  }
  private script(id: number): Sc3Script {
    const slot = this.context(id).getUint32(0x74, true),
      script = this.code.get(this.slotAddress('script', slot));
    if (!script) throw new Error(`Unloaded script slot ${slot}`);
    return script;
  }
  private codeLocation(id: number): {script: Sc3Script; base: number; offset: number} {
    const pointer = Number(this.context(id).getBigUint64(0x158, true));
    // Native fetch dereferences PC directly; +74 independently selects label/data reads.
    for (const [base, script] of this.code) {
      if (pointer >= base && pointer <= base + script.bytes.length)
        return {script, base, offset: pointer - base};
    }
    throw new Error(`Unmapped script PC 0x${pointer.toString(16)}`);
  }
  pc(id: number): number {
    return this.codeLocation(id).offset;
  }
  private setPc(id: number, pc: number): void {
    const {script, base} = this.codeLocation(id);
    checkRange(script.bytes.length, pc, 0);
    this.context(id).setBigUint64(0x158, BigInt(base + pc), true);
  }
  private byte(id: number): number {
    const {script, offset} = this.codeLocation(id),
      b = script.u8(offset);
    this.setPc(id, offset + 1);
    return b;
  }
  private word(id: number): number {
    return this.byte(id) | (this.byte(id) << 8);
  }
  private labelAddress(
    slot: number,
    label: number,
    returnTable: boolean | 'strings' = false,
  ): number {
    const base = this.slotAddress('script', slot),
      script = this.code.get(base);
    if (!script) throw new Error(`Unloaded script slot ${slot}`);
    const offset = returnTable
      ? script.u32(
          (script.u32(returnTable === 'strings' ? 4 : 8) | 0) + (Math.imul(label, 4) >>> 0),
        )
      : script.u32((Math.imul(label, 4) + 12) >>> 0);
    checkRange(script.bytes.length, offset, 1);
    return base + offset;
  }
  private expression(id: number): number {
    const s = this.state,
      ctx = (handle: number | undefined) =>
        this.context(handle === undefined ? id : handle & 0x7fffffff);
    const host: ExpressionHost = {
      // Scene events temporarily point this same context into MES data.
      byte: () => {
        const c = this.context(id),
          pc = c.getBigUint64(0x158, true),
          value = this.dataByte(Number(pc));
        c.setBigUint64(0x158, pc + 1n, true);
        return value;
      },
      readVariable: (i) => s.variable(i),
      writeVariable: (i, v) => s.setVariable(i, v),
      readFlag: (i) => s.flag(i),
      writeFlag: (i, v) => s.setFlag(i, v),
      readContext: (h, i) => {
        checkRange(0x160, i * 4, 4);
        return ctx(h).getInt32(i * 4, true);
      },
      writeContext: (h, i, v) => {
        checkRange(0x160, i * 4, 4);
        ctx(h).setInt32(i * 4, v, true);
      },
      readScript: (slot, offset) => {
        const script =
          slot === undefined ? this.script(id) : this.code.get(this.slotAddress('script', slot));
        if (!script) throw new Error(`Unloaded script slot ${slot}`);
        return script.u32(offset) | 0;
      },
      inputPressed: s.get(0x5a70d4),
      inputHeld: s.get(0x5a70d0),
      random15: this.options.random15,
    };
    return this.expressions.evaluate(host);
  }
  private slotAddress(bank: ScriptBank, slot: number): number {
    checkRange(16, slot, 1);
    return Number(
      this.state
        .view((bank === 'script' ? 0x17adcb0 : 0x17abc10) + slot * 8, 8)
        .getBigUint64(0, true),
    );
  }
  private setSlotAddress(bank: ScriptBank, slot: number, address: number): void {
    checkRange(16, slot, 1);
    this.state.put((bank === 'script' ? 0x17adcb0 : 0x17abc10) + slot * 8, address, 8);
  }
  /** 14005f5e0. Assembly reads group BEFORE clearing +14; Ghidra's ordering is misleading. */
  releaseContext(id: number): void {
    const c = this.context(id),
      group = c.getUint32(0x14, true),
      prev = Number(c.getBigUint64(0x140, true)) - NATIVE_BASE,
      next = Number(c.getBigUint64(0x148, true)) - NATIVE_BASE;
    checkRange(12, group, 1);
    this.pointer(next + 0x140, prev);
    this.pointer(prev + 0x148, next);
    this.state.zero(POOL + id * 0x160, 0x70);
    this.state.zero(POOL + id * 0x160 + 0x74, 0xcc);
    c.setBigUint64(0x158, 0n, true);
    this.state.put(0x17ab8b0 + group * 4, this.state.get(0x17ab8b0 + group * 4) - 1);
    this.pointer(POOL + id * 0x160 + 0x140, prev);
    this.pointer(POOL + id * 0x160 + 0x148, next);
    this.pointer(
      POOL + id * 0x160 + 0x150,
      this.freeHead === undefined ? undefined : POOL + this.freeHead * 0x160,
    );
    this.freeHead = id;
  }
  private contextId(pointer: number): number {
    const id = (pointer - NATIVE_BASE - POOL) / 0x160;
    checkRange(100, id, 1);
    return id;
  }
  private loadHost(): ScriptBufferHost {
    return {
      move: (bank, source, destination) => {
        const address = this.slotAddress(bank, source);
        this.setSlotAddress(bank, destination, address);
        this.setSlotAddress(bank, source, 0);
        if (bank === 'script') {
          this.scripts[destination] = this.code.get(address);
          this.scripts[source] = undefined;
        } else {
          this.messages[destination] = undefined;
          this.messages[source] = undefined;
        }
      },
      release: (bank, slot) => {
        const address = this.slotAddress(bank, slot);
        if (bank === 'script') {
          this.code.delete(address);
          this.scripts[slot] = undefined;
        } else {
          this.messageBuffers.delete(address);
          this.messages[slot] = undefined;
        }
        this.setSlotAddress(bank, slot, 0);
      },
      removeSlotContexts: (slot) => {
        for (let i = 0; i <= 100; i++) {
          const pointer = Number(this.state.view(0x17ab8e0 + i * 8, 8).getBigUint64(0, true));
          if (!pointer) break;
          const id = this.contextId(pointer);
          if (this.context(id).getUint32(0x74, true) === slot) this.releaseContext(id);
        }
      },
      start: (bank, asset, slot) => {
        if (this.state.get(0x587270) !== 0) return LOAD_BUSY;
        let size: number;
        try {
          size = this.assets.size(bank, asset);
          if (!Number.isSafeInteger(size) || size < 1 || size >= 0x1000000)
            throw new Error('Asset size outside loader bounds');
        } catch {
          return 0xf4237;
        } // Native start-error code; the following invalid-job access faults explicitly.
        const address = this.nextBuffer;
        this.nextBuffer += 0x1000000;
        const job: {
          bank: ScriptBank;
          slot: number;
          address: number;
          asset: number;
          size: number;
          promise: Promise<void>;
          bytes?: Uint8Array;
          error?: unknown;
        } = {bank, slot, address, asset, size, promise: Promise.resolve()};
        job.promise = Promise.resolve()
          .then(() => this.assets[bank](asset))
          .then((bytes) => {
            if (bytes.length !== size)
              throw new Error(`Loader size mismatch: expected ${size}, got ${bytes.length}`);
            job.bytes = Uint8Array.from(bytes);
          })
          .catch((error) => {
            job.error = error ?? new Error('Script transport rejected without an error');
          });
        this.jobs.set(0, job);
        this.state.put(0x5872c0, address, 8);
        this.state.put(0x587230, Math.ceil(size / 2048) * 2048);
        this.state.put(0x587270, 1);
        this.setSlotAddress(bank, slot, address);
        return 0;
      },
      take: (bank, slot, index) => {
        const address = Number(this.state.view(0x5872c0 + index * 8, 8).getBigUint64(0, true));
        this.setSlotAddress(bank, slot, address);
        if (bank === 'script') this.scripts[slot] = this.code.get(address);
        else this.messages[slot] = undefined;
        this.jobs.delete(index);
      },
      rebuildMessages: (slot) => {
        const bytes = this.messageBuffers.get(this.slotAddress('messages', slot));
        if (!bytes) throw new Error(`Missing completed message buffer for slot ${slot}`);
        this.messages[slot] = new MesScript(bytes);
      },
    };
  }
  /** Await transport only. VM-visible completion is published separately after dispatch. */
  async settleLoads(includeAudio = true): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .map((job) => job.promise)
        .concat(
          this.textureLoader.settle(),
          this.backgroundLoader.settle(),
          this.storage.settle(),
          this.rawAssets.settle(),
          this.characterAssets.settle(),
          includeAudio ? this.audio.settle() : Promise.resolve(),
        ),
    );
  }
  publishLoadCompletions(): void {
    if (this.frameIndex !== undefined || this.dispatch.length)
      throw new Error('Cannot publish I/O during a suspended VM frame');
    this.audio.publish();
    this.textureLoader.publish();
    this.backgroundLoader.publish();
    this.rawAssets.publish();
    this.characterAssets.publish();
    this.storage.advance();
    for (const [index, job] of this.jobs) {
      if (this.state.get(0x587270 + index * 4) !== 1) continue;
      if (job.error !== undefined) {
        this.state.put(0x587270 + index * 4, 2);
        continue;
      }
      if (!job.bytes) continue;
      try {
        if (job.bank === 'script') {
          const script = new Sc3Script(job.asset, job.bytes);
          this.code.set(job.address, script);
          if (this.slotAddress('script', job.slot) === job.address) this.scripts[job.slot] = script;
        } else this.messageBuffers.set(job.address, job.bytes);
        // 14001e4c0 replaces allocation capacity with the completed byte count.
        this.state.put(0x587230 + index * 4, job.size);
        this.state.put(0x587270 + index * 4, 0);
      } catch (error) {
        job.error = error ?? new Error('Script transport rejected without an error');
        this.state.put(0x587270 + index * 4, 2);
      }
    }
  }
  get loadErrors(): readonly unknown[] {
    return [...this.jobs.values()]
      .filter((j) => j.error !== undefined)
      .map((j) => j.error)
      .concat(
        this.textureLoader.errors,
        this.backgroundLoader.errors,
        this.rawAssets.errors,
        this.characterAssets.errors,
      );
  }
  /** 14005ef10: one VM scheduling pass. Media/input/frame presentation remain host services. */
  runFrame(budgetPerContext = 10000): 'complete' | 'budget' | 'blocked' | 'exited' {
    if (this.fault) throw this.fault;
    if (this.frameIndex === undefined) {
      // 140055150 writes application +0x1a5; 14001e090 consumes it on the
      // next host pump. Finish the requesting scheduling pass before closing.
      if (this.exitRequest) {
        if (!this.exited) {
          this.exited = true;
          this.audio.dispose();
          this.movies.dispose();
        }
        return 'exited';
      }
      // 14001e4c0 clears these transient input fields after device polling.
      // A suspended pass retains them until the next genuinely new pass.
      this.state.put(0x543836, 0, 1);
      this.state.zero(0x586a58, 8);
      this.movies.advance(this.textures);
      updateFrame({
        state: this.state,
        input: this.input,
        sound: (id, volume) => this.assets.sound?.(id, volume),
      });
      const ids: number[] = [];
      for (let group = 0; group < 12; group++) {
        const flags = this.state.get(0x17ab880 + group * 4),
          tail = GROUPS + group * 0x2c0 + 0x160;
        if (!(flags & 0x08000000) && flags & 0x40000000) continue;
        let address =
          Number(this.state.view(GROUPS + group * 0x2c0 + 0x148, 8).getBigUint64(0, true)) -
          NATIVE_BASE;
        for (let visited = 0; address !== tail; visited++) {
          if (visited >= 100) throw new Error('Cyclic context group list');
          const id = this.contextId(NATIVE_BASE + address),
            c = this.context(id),
            next = Number(c.getBigUint64(0x148, true)) - NATIVE_BASE;
          if (flags & 0x08000000 || c.getUint32(0, true) & 0x08000000) this.releaseContext(id);
          else if (!(c.getUint32(0, true) & 0x40000000)) ids.push(id);
          address = next;
        }
        if (flags & 0x08000000) this.state.put(0x17ab880 + group * 4, flags ^ 0x08000000);
      }
      // Native performs swaps, so equal-priority entries need not retain insertion order.
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          if (
            this.context(ids[i]!).getInt32(0x10, true) < this.context(ids[j]!).getInt32(0x10, true)
          )
            [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      ids.forEach((id, i) => this.pointer(0x17ab8e0 + i * 8, POOL + id * 0x160));
      this.pointer(0x17ab8e0 + ids.length * 8, undefined);
      this.frameIndex = 0;
    }
    for (;;) {
      const pointer = Number(
        this.state.view(0x17ab8e0 + this.frameIndex * 8, 8).getBigUint64(0, true),
      );
      if (!pointer) break;
      const result = this.runContext(this.contextId(pointer), budgetPerContext);
      if (result === 'budget' || result === 'blocked') return result;
      this.frameIndex++;
    }
    for (let i = 0; i <= 100; i++) {
      const pointer = Number(this.state.view(0x17ab8e0 + i * 8, 8).getBigUint64(0, true));
      if (!pointer) break;
      const id = this.contextId(pointer);
      if (this.context(id).getUint32(0, true) & 0x08000000) this.releaseContext(id);
    }
    this.frameIndex = undefined;
    this.audio.advance();
    return 'complete';
  }
  async waitHost(): Promise<void> {
    await this.hostBlock?.promise;
  }
  runContext(id: number, budget = 10000): 'yield' | 'budget' | 'blocked' {
    if (this.fault) throw this.fault;
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Invalid instruction budget');
    if (this.hostBlock) {
      const block = this.hostBlock;
      if (!block.done) return 'blocked';
      this.hostBlock = undefined;
      block.finish();
    }
    if (this.dispatch.length && this.dispatch[0]!.id !== id)
      throw new Error('Resume the suspended root context first');
    if (!this.dispatch.length) {
      this.dispatch.push({id});
      this.state.put(0x179cd24, 0);
    }
    for (let instruction = 0; instruction < budget; instruction++) {
      const frame = this.dispatch[this.dispatch.length - 1]!;
      id = frame.id;
      let child: number | undefined, hostPromise: Promise<void> | undefined;
      const c = this.context(id),
        slot = c.getUint32(0x74, true);
      let pc = Number(c.getBigUint64(0x158, true)),
        asset = -1,
        bytes = '';
      let operation: string;
      try {
        const location = this.codeLocation(id),
          script = location.script;
        pc = location.offset;
        asset = script.assetId;
        bytes = [...script.bytes.subarray(pc, pc + 24)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        const first = script.u8(pc),
          group = first & 0x7f;
        if (first === 0xfe) {
          operation = 'expression';
          this.setPc(id, pc + 1);
          this.expression(id);
        } else {
          const opcode = script.u8(pc + 1);
          const handler = opcodeGroups.get(group)?.get(opcode);
          if (!handler)
            throw new Error(
              `Unimplemented opcode ${group.toString(16).padStart(2, '0')}/${opcode.toString(16).padStart(2, '0')}`,
            );
          operation = handler.name;
          const original = c.getBigUint64(0x158, true);
          const invocation: OpcodeExecution = {
            scriptBuffers: this.loadHost(),
            movies: this.movies,
            stopAudioDevice: (channel) => this.audio.stopDevice(channel),
            sceneText: this.sceneText,
            messageIndex: (slot, id) => {
              const index = this.messages[slot]?.byId.get(id);
              if (index === undefined) throw new Error(`Missing MES ID ${id} in slot ${slot}`);
              return index;
            },
            resumeAudio: (channel) => this.audio.resume(channel),
            pauseAudio: (channel, paused) => this.audio.pause(channel, paused),
            requestExit: () => {
              this.exitRequest = true;
            },
            resetAudio: () => this.audio.reset(),
            state: this.state,
            manualPageCount: () => {
              if (!this.assets.manualPageCount) throw new Error('Missing native manual archive');
              return this.assets.manualPageCount();
            },
            backlog: this.backlog,
            achievement: (id) => awardNoahAchievement(this.achievements, id),
            sound: (id, volume) => this.assets.sound?.(id, volume),
            rawAssets: this.rawAssets,
            characterAssets: this.characterAssets,
            input: this.input,
            storage: this.storage,
            localTime: () => this.options.localTime?.() ?? new Date(),
            uploadThumbnail: (id, bytes) => this.textures.uploadRgba(id, bytes, 240, 135),
            context: c,
            configEnabled: this.options.configEnabled ?? this.storage.configurationMissing,
            textures: this.textureLoader,
            backgroundTextures: this.backgroundLoader,
            tips: this.tips,
            messageBoxes: this.messageBoxes,
            messageAddress: (slot, id) => this.messageAddress(slot, id),
            language: this.currentLanguage,
            setLanguage: (language) => this.selectLanguage(language as NoahLanguage),
            skip: (count) => this.setPc(id, this.pc(id) + count),
            byte: () => this.byte(id),
            word: () => this.word(id),
            expression: () => this.expression(id),
            textExpression: (address) => this.textExpression(address).value,
            labelAddress: (slot, label, returns) => this.labelAddress(slot, label, returns),
            stringAddress: (slot, label) => this.labelAddress(slot, label, 'strings'),
            scriptByte: (pointer) => this.dataByte(pointer),
            loadScripts: (mode, slot, asset) =>
              scriptLoad(this.state, this.loadHost(), mode, slot, asset),
            spawn: (group, slot, address) => {
              child = this.allocateContext(group);
              const spawned = this.context(child);
              spawned.setBigUint64(0x158, BigInt(address), true);
              spawned.setInt32(0x14, group, true);
              spawned.setUint32(0x74, slot, true);
              c.setInt32(0x1c, spawned.getInt32(0x70, true) + 0x80000000, true);
              spawned.setInt32(0x1c, c.getInt32(0x70, true) + 0x80000000, true);
            },
            yield: () => this.state.put(0x179cd24, 1),
            retry: () => {
              c.setBigUint64(0x158, original, true);
              this.state.put(0x179cd24, 1);
            },
          };
          hostPromise = handler.execute(invocation) ?? undefined;
        }
        const currentId = id;
        const finish = () => {
          this.trace.push({
            context: currentId,
            slot,
            asset: script.assetId,
            pc,
            bytes,
            operation,
            nextPc: this.pc(currentId),
            result: c.getInt32(0x1c, true),
            yielded: this.state.get(0x179cd24) !== 0,
          });
          if (this.options.traceLimit !== undefined && this.trace.length > this.options.traceLimit)
            this.trace.splice(0, this.trace.length - this.options.traceLimit);
        };
        if (hostPromise) {
          const block = {
            promise: Promise.resolve(),
            done: false,
            finish: () => {},
            error: undefined as unknown,
          };
          block.promise = hostPromise.then(
            () => {
              block.done = true;
            },
            (error) => {
              block.error = error;
              block.done = true;
            },
          );
          block.finish = () => {
            if (block.error !== undefined) {
              this.fault = new Sc3Fault(currentId, slot, asset, pc, bytes, String(block.error));
              throw this.fault;
            }
            finish();
          };
          this.hostBlock = block;
          return 'blocked';
        }
        if (child !== undefined) {
          frame.finish = finish;
          this.dispatch.push({id: child});
          this.state.put(0x179cd24, 0);
        } else {
          finish();
          if (this.state.get(0x179cd24) !== 0) {
            this.dispatch.pop();
            if (!this.dispatch.length) return 'yield';
            // 140051d80 clears the shared yield flag after its nested call returns.
            this.state.put(0x179cd24, 0);
            const parent = this.dispatch[this.dispatch.length - 1]!;
            parent.finish!();
            delete parent.finish;
          }
        }
      } catch (error) {
        this.fault = new Sc3Fault(
          id,
          slot,
          asset,
          pc,
          bytes,
          error instanceof Error ? error.message : String(error),
          {cause: error},
        );
        throw this.fault;
      }
    }
    return 'budget';
  }
}
