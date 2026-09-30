import {parseGsc, type GscProgram} from '../../../formats/rscript/gsc.js';
import type {RScriptApini} from '../apini.js';
import {initializeConfig, initializeScene} from '../defaults.js';
import type {RScriptFiles} from '../files.js';
import {ADD_TABLE, createSurface, scaleRgb, type RScriptSurface} from '../graphics/pixels.js';
import {encodeWcg} from '../../../formats/rscript/wcg.js';
import {RScriptContainer, RScriptSprite, type RScriptNode} from '../graphics/sprite.js';
import {RScriptImages} from '../images.js';
import {Config, GAME_VARIABLE_COUNT, Scene, RScriptMemory} from '../memory.js';
import {decodeSlotSave, decodeSystemSave, encodeSlotSave, encodeSystemSave} from '../saves.js';
import {RSCRIPT_1_11_LAYOUTS} from '../vm/layouts.js';
import {
  RScriptInterpreter,
  RScriptScriptEnd,
  type RScriptNativeHandler,
} from '../vm/interpreter.js';
import {loadFrameAnimation} from './animation.js';
import {AudioChannel, RScriptAudio} from './audio.js';
import {RScriptChoiceWindow} from './choice.js';
import {RScriptSaveScreen} from './save-screen.js';
import {RScriptConfigScreen, type ConfigChange, type ConfigCommand} from './config-screen.js';
import {RScriptDisplay, type RScriptPresenter, type RScriptTimer} from './display.js';
import {RScriptLayer} from './layer.js';
import {MessageState, RScriptMessageWindow} from './message-window.js';
import type {PanelCommand} from './message-panel.js';
import {createOpcodeHandlers} from './opcodes.js';
import type {GlyphRasterizer} from './text-block.js';
import {decodeCp932} from '../text.js';

/** Installation-local persistent files such as `FRsave.dat` and `FRsave01.dat`. */
export interface RScriptSaveStorage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
}

export interface RScriptGameHost {
  readonly files: RScriptFiles;
  readonly apini: RScriptApini;
  readonly presenter: RScriptPresenter;
  readonly timer: RScriptTimer;
  readonly rasterizer: GlyphRasterizer;
  readonly audio: BaseAudioContext;
  readonly saves: RScriptSaveStorage;
  /** Plays an installation-relative movie; resolves when it ends or is skipped. */
  playMovie(path: string): Promise<void>;
  /** Ends a movie started by `playMovie` early, when the scene restarts. */
  stopMovie(): void;
  /**
   * Asks the player to confirm (the MessageBox with OK and Cancel that titles without a
   * custom dialog image use); resolves true for OK.
   */
  confirm(caption: string, text: string): Promise<boolean>;
  /**
   * Font families the configuration's font window lists (0x4572F0): fixed-pitch TrueType
   * families with Shift-JIS support, by their Japanese names. Called from the font button's
   * press, so a browser can ask for font access.
   */
  listFonts?(): Promise<readonly string[]>;
  /** The configuration's window/fullscreen option (sub_452990). */
  setFullscreen?(fullscreen: boolean): void;
  /** Shows or hides the pointer over the game (ShowCursor). */
  setCursorVisible?(visible: boolean): void;
  diagnostic(message: string): void;
  /** The script thread ended (the native game closes its window) or failed. */
  exit(error?: unknown): void;
}

/** Script-thread and timer flags of the native game scene (0x485328..0x485394). */
export class RScriptFlags {
  /** A choice is waiting for an answer (485328). */
  choice = false;
  /** Layer commands are collected until 0x1B or a transition (485330). */
  batch = false;
  /** A click asks running animations to finish (485334). */
  completeAnimations = false;
  /** The script waits for input; only idle animations tick (485338). */
  waitInput = false;
  /** A timed button wait counts down (48533C). */
  buttonTimer = false;
  /** The script waits until nothing animates (485340). */
  waitAnimation = false;
  /** A click resumes the script (485348). */
  waitClick = false;
  /** An interruptible sleep is running (48534C). */
  sleeping = false;
  /** A mode-2 button asked for a system call after the wait (485350). */
  interrupt = false;
  /** A click stops the waited sound or voice (485354, 485358). */
  waitSound = false;
  waitVoice = false;
  /** Skip requested by the control key or the panel (485360) and active skipping (485368). */
  skipHeld = false;
  skip = false;
  /** State-only fast skip to the next choice; the display is rebuilt afterwards (48536C). */
  fastSkip = false;
  /** Fast skip requested by the panel, latched before the next instruction (485364). */
  fastSkipRequest = false;
  /** Auto mode (485370). */
  auto = false;
  /** Kind of the active button wait: 1 buttons, 3 pointer (word_485384). */
  buttonWait = 0;
  /** The right button cancels the button wait (485388). */
  buttonCancel = false;
  /** The player hid the message window (485394). */
  windowHidden = false;
}

/** The native script thread waits on an auto-reset event (hEvent) signalled by input and ticks. */
class ScriptEvent {
  private signaled = false;
  private waiter: (() => void) | null = null;
  set(): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter();
    } else this.signaled = true;
  }
  /** Drops a signal nobody waited for (ResetEvent), before a new scene thread starts. */
  reset(): void {
    this.signaled = false;
  }
  wait(): Promise<void> {
    if (this.signaled) {
      this.signaled = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

/** Confirmation messages of the RScript 1.11 executable (0x481550..0x4821DC). */
export const RScriptMessages = {
  confirm: '確認',
  returnToTitle: 'タイトル画面に戻ります。\r\nよろしいですか？',
  overwrite: 'セーブデータを上書きします。\r\nよろしいですか？',
  load: 'セーブデータをロードします。\r\nよろしいですか？',
  quickLoad: 'クイックロードしますか？',
  quitCaption: '終了確認',
  quit: '本当にゲームを終了しますか？',
} as const;

/**
 * The RScript game scene (0x41E760 tick, 0x422FD0 script thread, 0x4292C0 rebuild): layers,
 * message window and effect sprites over the scene state in `memory`, driven by one script
 * coroutine and a fixed-period tick.
 */
export class RScriptGame {
  readonly memory = new RScriptMemory();
  readonly flags = new RScriptFlags();
  readonly images: RScriptImages;
  readonly audio: RScriptAudio;
  readonly display: RScriptDisplay;
  /** Root of the scene objects (dword_48507C). */
  readonly root: RScriptContainer;
  readonly layers: readonly RScriptLayer[];
  readonly message: RScriptMessageWindow;
  /** Choice window (dword_48509C). */
  readonly choice: RScriptChoiceWindow;
  /** Save and load screen (dword_485098) over a still of the scene (dword_48524C). */
  readonly saveScreen: RScriptSaveScreen;
  /** Configuration screen (dword_485240). */
  readonly configScreen: RScriptConfigScreen;
  private readonly backdrop = new RScriptSprite();
  /** Scaled still of the scene at the last menu opening, saved with slots (dword_4850A0). */
  private thumbnail: RScriptSurface | null = null;
  /** Native screen state (485374, 48537C, 485378, 485390) and the standalone title screens. */
  private readonly screens = {
    open: false,
    save: false,
    fromMenu: false,
    resume: false,
    /** The standalone title screen in use (scenes 485306 and 48530E), if any. */
    standalone: null as 'load' | 'config' | null,
  };
  /** Effect screen image (dword_485080) and full-screen tone overlay (dword_485244). */
  readonly effectScreen = new RScriptSprite();
  readonly overlay = new RScriptSprite();
  readonly vm: RScriptInterpreter;
  /** Nested system calls in progress (word_4853A6). */
  nesting = 0;
  private readonly event = new ScriptEvent();
  private readonly programs = new Map<number, Promise<GscProgram>>();
  private readonly reported = new Set<string>();
  private readonly handlers: ReadonlyMap<number, RScriptNativeHandler>;
  private hovered: RScriptNode | null = null;
  private pressed: RScriptNode | null = null;
  /** Last pointer position in game coordinates (GetCursorPos for pointer waits). */
  readonly pointer = {x: 0, y: 0};
  /** Input-wait ticks since the last input, and whether auto-hide is in effect. */
  private idleTicks = 0;
  private idleHidden = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Incremented when the scene thread restarts (a load or a return to the title). */
  private sceneGeneration = 0;
  /** The running scene thread. */
  private running: Promise<void> = Promise.resolve();

  constructor(readonly host: RScriptGameHost) {
    const {apini} = host;
    this.images = new RScriptImages(host.files);
    this.display = new RScriptDisplay(apini.width, apini.height, host.presenter, host.timer);
    this.audio = new RScriptAudio(
      {
        context: host.audio,
        read: (path) => host.files.read(path),
        diagnostic: (m) => this.diagnostic(m),
      },
      apini.directories.music,
    );
    this.root = new RScriptContainer(apini.width, apini.height);
    this.display.screen.add(this.root, 0);
    this.layers = Array.from({length: Scene.layerCount}, (_, index) => {
      const layer = new RScriptLayer(index, {
        memory: this.memory,
        images: this.images,
        width: apini.width,
        height: apini.height,
        renderText: (text, size) => this.renderText(text, size),
        buttonPressed: (_, mode, id) => this.buttonPressed(mode, id),
        animation: (path) => loadFrameAnimation(this.images, host.files, path),
        variable: (i) => this.memory.variables[i] ?? 0,
        random: () => this.vm.random.next(),
        diagnostic: (m) => this.diagnostic(m),
      });
      this.root.add(layer, 0);
      return layer;
    });
    const palette = Array.from({length: 10}, (_, i) => apini.u32(440 + 4 * i));
    this.message = new RScriptMessageWindow({
      memory: this.memory,
      images: this.images,
      rasterizer: host.rasterizer,
      systemDirectory: apini.directories.system,
      palette,
      shadow: apini.u16(500) !== 0,
      scriptString: (script, index) => this.scriptString(script, index),
      backlogColor: apini.u16(502) ? apini.u32(504) : null,
      command: (command) => this.panelCommand(command),
      windowAlpha: (value) => this.memory.setConfigWord(Config.windowAlpha, value),
    });
    this.root.add(this.overlay, 1);
    this.root.add(this.effectScreen, 1);
    this.root.add(this.message, 50);
    this.choice = new RScriptChoiceWindow({
      images: this.images,
      rasterizer: host.rasterizer,
      systemDirectory: apini.directories.system,
      width: apini.width,
      height: apini.height,
      palette,
      textSize: apini.u16(494),
      textColor: apini.u32(484),
      answered: () => this.choiceAnswered(),
    });
    this.root.add(this.choice, 100);
    this.saveScreen = new RScriptSaveScreen({
      memory: this.memory,
      images: this.images,
      rasterizer: host.rasterizer,
      systemDirectory: apini.directories.system,
      width: apini.width,
      height: apini.height,
      palette,
      dateSize: apini.u16(496),
      pageCount: apini.u16(438),
      readSlot: (slot) => this.readSlot(slot),
      readThumbnail: (slot) => this.host.saves.read(this.slotName(slot, 'wcg')),
      choose: (slot, save) => void this.chooseSlot(slot, save),
      close: () => void this.closeScreen(),
      sound: (sound) => this.playSystemSound(sound),
    });
    this.configScreen = new RScriptConfigScreen({
      memory: this.memory,
      images: this.images,
      rasterizer: host.rasterizer,
      systemDirectory: apini.directories.system,
      width: apini.width,
      height: apini.height,
      palette,
      sound: (sound) => {
        if (this.config(Config.soundEnabled)) this.playSystemSound(sound);
      },
      changed: (change) => this.configChanged(change),
      command: (command) => void this.configCommand(command),
      listFonts: () => host.listFonts?.() ?? Promise.resolve([]),
    });
    this.display.screen.add(this.backdrop, 0);
    this.display.screen.add(this.configScreen, 1);
    this.display.screen.add(this.saveScreen, 3);
    this.overlay.setSurface(createSurface(apini.width, apini.height, 0xffffff));
    this.overlay.setBlendMode(0x6c);
    this.effectScreen.setBlendMode(0x68);
    this.handlers = createOpcodeHandlers(this);
    this.vm = this.createInterpreter();
  }

  get apini(): RScriptApini {
    return this.host.apini;
  }
  get width(): number {
    return this.apini.width;
  }
  get height(): number {
    return this.apini.height;
  }
  config(offset: number): number {
    return this.memory.configWord(offset);
  }
  get effectsEnabled(): boolean {
    return this.config(Config.effectsEnabled) !== 0;
  }
  /** Script number of the current call depth (word_485C52[depth]). */
  get currentScript(): number {
    return this.vm.scriptAt(this.vm.depth);
  }

  diagnostic(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.host.diagnostic(message);
  }

  private createInterpreter(): RScriptInterpreter {
    return new RScriptInterpreter(this.memory, RSCRIPT_1_11_LAYOUTS, this.handlers, {
      program: (script) => this.program(script),
      yieldFrame: () => this.suspend(),
      beforeStep: () => {
        const {flags} = this;
        if (!flags.batch) flags.skip = flags.skipHeld;
        if (flags.fastSkipRequest) {
          flags.fastSkip = true;
          flags.fastSkipRequest = false;
        }
      },
      diagnostic: (m) => this.diagnostic(m),
    });
  }

  program(script: number): Promise<GscProgram> {
    let program = this.programs.get(script);
    if (!program) {
      const path = `${this.apini.directories.scripts}\\${pad(script, 4)}.gsc`;
      program = this.host.files.read(path).then((bytes) => {
        if (!bytes) throw new Error(`Missing script ${path}`);
        return parseGsc(bytes);
      });
      program.catch(() => this.programs.delete(script));
      this.programs.set(script, program);
    }
    return program;
  }
  private async scriptString(script: number, index: number): Promise<Uint8Array> {
    const program = await this.program(script);
    const text = program.strings[index];
    if (!text) throw new Error(`String ${index} is out of range in script ${script}`);
    return this.vm.expand(text);
  }

  private async renderText(text: Uint8Array, size: number): Promise<RScriptSurface> {
    this.diagnostic(`Text layers are not supported yet (${text.length} bytes, size ${size})`);
    return createSurface(1, 1);
  }

  // Script thread primitives.

  /** sub_42AC50: waits for the scene event. */
  async suspend(): Promise<void> {
    const generation = this.sceneGeneration;
    await this.event.wait();
    if (this.disposed || generation !== this.sceneGeneration) throw new RScriptScriptEnd('stopped');
  }
  /** Resumes the script thread (SetEvent(hEvent)). */
  resume(): void {
    this.event.set();
  }
  /** sub_42ACC0: real-time sleep that a click interrupts. */
  async sleep(milliseconds: number): Promise<void> {
    const {timer} = this.host;
    const end = timer.now() + milliseconds;
    this.flags.sleeping = true;
    while (this.flags.sleeping && !this.disposed) {
      const remaining = end - timer.now();
      if (remaining <= 0) break;
      await timer.sleep(Math.min(10, remaining));
    }
    this.flags.sleeping = false;
    if (this.disposed) throw new RScriptScriptEnd('stopped');
  }
  /** sub_425130: presents layer changes, waiting for their effects unless skipping. */
  async refresh(): Promise<void> {
    if (this.flags.fastSkip) return;
    if (this.flags.skip || !this.effectsEnabled) {
      this.display.update();
      return;
    }
    this.flags.waitAnimation = true;
    await this.suspend();
  }
  /** Ends a pending batch, as the native commands that must see the screen do. */
  async flushBatch(): Promise<void> {
    if (!this.flags.batch) return;
    this.flags.batch = false;
    await this.refresh();
  }
  /** Layer targets: 0 is every layer from 1, 1..100 one layer, larger values a group. */
  targets(id: number): RScriptLayer[] {
    if (id === 0) return this.layers.slice(1);
    if (id <= 100) {
      const layer = this.layers[id];
      if (!layer) this.diagnostic(`Layer ${id} is out of range`);
      return layer ? [layer] : [];
    }
    const group = id % 100;
    return this.layers.filter(
      (_, i) => i > 0 && this.memory.sceneWord(Scene.layerGroups + 2 * i) === group,
    );
  }

  /** sub_4261F0: auto mode waits the configured time, then for the voice. */
  private async autoWait(): Promise<void> {
    const wait = this.config(Config.autoWait) & 0xffff;
    for (let i = 0; i <= wait / 10 && this.flags.auto; i++) await this.sleep(10);
    if (this.flags.auto) await this.audio.waitEnd(AudioChannel.voice);
  }

  /** sub_426250 and opcodes 0x0A/0x0B: waits for a click, running interrupt calls. */
  async waitClick(): Promise<void> {
    const {flags} = this;
    if (flags.skip || flags.fastSkip) return;
    if (flags.auto) {
      flags.waitInput = true;
      await this.autoWait();
      flags.waitInput = false;
      return;
    }
    for (;;) {
      flags.interrupt = false;
      this.message.setWaiting(true);
      flags.waitInput = true;
      this.message.setInput(true);
      this.setButtonInput(true, true);
      flags.waitClick = true;
      await this.suspend();
      flags.waitClick = false;
      this.setButtonInput(false, true);
      this.message.setInput(false);
      this.message.setWaiting(false);
      flags.waitInput = false;
      if (!flags.interrupt) break;
      await this.systemCall(this.memory.variables[0]!);
    }
  }
  /** sub_407310 / sub_407360 over every layer. */
  setButtonInput(enabled: boolean, onlyInterrupts: boolean): void {
    for (const layer of this.layers) layer.setButtonInput(enabled, onlyInterrupts);
  }

  /** sub_4290A0: runs a script in a nested thread and restores the scene afterwards. */
  async systemCall(script: number): Promise<number> {
    await this.flushBatch();
    this.flags.skip = false;
    this.flags.fastSkip = false;
    this.stopAuto();
    const memory = this.memory;
    const scene = memory.scene.slice();
    const backlogStart = Scene.message + MessageState.backlog;
    const backlog = memory.scene.slice(backlogStart, backlogStart + 0x3840);
    const outer = {program: this.vm.program, script: this.vm.script, pc: this.vm.pc};
    const generation = this.sceneGeneration;
    this.nesting++;
    try {
      for (const layer of this.layers.slice(1)) layer.stopButton(true, false);
      this.message.clear(0, false);
      await this.message.showBox(0, false, false);
      memory.setSceneWord(Scene.callDepth, 0);
      const nested = this.createInterpreter();
      await nested.load(script);
      await nested.run();
      await this.flushBatch();
      this.flags.skip = false;
      this.flags.fastSkip = false;
      this.stopAuto();
    } finally {
      this.nesting--;
      // A load inside the call replaced the scene; it must not be restored over.
      if (generation === this.sceneGeneration) {
        memory.scene.set(scene);
        memory.scene.set(backlog, backlogStart);
        Object.assign(this.vm, outer);
      }
    }
    if (generation !== this.sceneGeneration) throw new RScriptScriptEnd('stopped');
    await this.rebuild();
    return this.memory.variables[0]!;
  }
  /** Leaving auto mode brings the panel back (sub_417820). */
  stopAuto(): void {
    if (!this.flags.auto) return;
    this.flags.auto = false;
    this.message.restorePanel();
    this.display.update();
  }

  // Scene reconstruction.

  /** sub_429230: restarts music and loops, then rebuilds every object from the scene. */
  async rebuild(): Promise<void> {
    const memory = this.memory;
    const music = memory.sceneUword(Scene.music);
    if (music) this.playMusic(music, true, 0);
    for (let channel = 0; channel < 3; channel++) {
      const base = Scene.soundChannels + channel * Scene.soundChannelStride;
      const sound = memory.sceneUword(base);
      if (!sound) continue;
      this.loadSound(channel, sound);
      if (memory.sceneUword(base + 2)) this.playSound(channel, 999, 1, memory.sceneWord(base + 4));
    }
    await this.rebuildObjects();
    this.display.update();
  }
  /** sub_4292C0 */
  private async rebuildObjects(): Promise<void> {
    const memory = this.memory;
    for (const layer of this.layers) {
      this.root.setPriority(layer, memory.sceneWord(Scene.layerOrders + 2 * layer.index));
      await layer.restore();
    }
    await this.message.restore();
    this.root.setPriority(this.effectScreen, memory.sceneWord(Scene.effectOrder));
    await this.applyEffectScreen();
    this.root.setPriority(this.overlay, memory.sceneWord(Scene.overlayOrder));
    this.applyOverlay();
  }
  async applyEffectScreen(): Promise<void> {
    const image = this.memory.sceneUword(Scene.effectImage);
    if (!image) {
      this.effectScreen.show(false);
      return;
    }
    const path = `${this.apini.directories.system}\\es${pad(image, 3)}`;
    const surface = await this.images.image(path);
    if (!surface) this.diagnostic(`Missing image ${path}`);
    this.effectScreen.setSurface(surface);
    this.effectScreen.show(true);
    this.effectScreen.setBlendMode(this.memory.sceneWord(Scene.effectBlend) === 1 ? 0x67 : 0x68);
  }
  applyOverlay(): void {
    const percent = this.memory.sceneUword(Scene.overlayPercent);
    if (!percent) {
      this.overlay.show(false);
      return;
    }
    this.overlay.setAlpha(Math.trunc((255 * percent) / 100));
    this.overlay.show(true);
    this.overlay.setBlendMode(this.memory.sceneWord(Scene.overlayBlend) === 1 ? 0x6d : 0x6c);
  }

  // Audio (0x41BC10, 0x428CC0, 0x428D50, 0x428E10, 0x421910).

  playMusic(track: number, fade: boolean, fadeSteps: number): void {
    this.memory.setSceneWord(Scene.music, track);
    if (this.flags.fastSkip || !this.config(Config.musicEnabled)) return;
    this.audio.playMusic(track, fade && !this.flags.skip, fadeSteps);
  }
  stopMusic(fade: boolean, fadeSteps: number): void {
    this.memory.setSceneWord(Scene.music, 0);
    if (this.flags.fastSkip) return;
    this.audio.stopMusic(fade && !this.flags.skip, fadeSteps);
  }
  private soundBase(channel: number): number {
    return Scene.soundChannels + (channel > 2 ? 0 : channel) * Scene.soundChannelStride;
  }
  loadSound(channel: number, sound: number): void {
    const index = channel > 2 ? 0 : channel;
    this.memory.setSceneWord(this.soundBase(index), sound);
    if (!sound || this.flags.fastSkip) return;
    this.stopSound(index, false);
    this.audio.load(
      AudioChannel.effect + index,
      `${this.apini.directories.sounds}\\${pad(sound, 4)}.wav`,
    );
  }
  playSound(channel: number, repeat: number, fade: number, pan: number): void {
    const index = channel > 2 ? 0 : channel;
    const base = this.soundBase(index);
    if (repeat === 999) this.memory.setSceneWord(base + 2, 1);
    this.memory.setSceneWord(base + 4, pan);
    if (this.flags.fastSkip || !this.config(Config.soundEnabled)) return;
    const loops = repeat === 999 ? -1 : repeat ? repeat - 1 : 0;
    this.audio.setPan(AudioChannel.effect + index, pan);
    this.audio.play(AudioChannel.effect + index, loops, !!fade && !this.flags.skip);
  }
  stopSound(channel: number, fade: boolean): void {
    const index = channel > 2 ? 0 : channel;
    this.memory.setSceneWord(this.soundBase(index) + 2, 0);
    if (this.flags.fastSkip) return;
    this.audio.stop(AudioChannel.effect + index, fade && !this.flags.skip);
  }
  playVoice(voice: number, loops: number, fade: boolean, pan: number): void {
    if (!this.config(Config.voiceEnabled)) return;
    const bank = Math.trunc(voice / 10000);
    if (!this.config(Config.voiceBanks + 2 * bank)) return;
    const directory = this.apini.directories.voices;
    const path = bank
      ? `${directory}\\${bank}\\${pad(voice % 10000, 4)}.wav`
      : `${directory}\\${pad(voice, 4)}.wav`;
    this.audio.load(AudioChannel.voice, path);
    this.audio.setPan(AudioChannel.voice, pan);
    this.audio.play(AudioChannel.voice, loops, fade);
  }
  /** sub_4218A0: system sound effect. */
  playSystemSound(sound: number): void {
    if (!this.config(Config.soundEnabled)) return;
    this.audio.load(AudioChannel.system, `${this.apini.directories.sounds}\\${pad(sound, 4)}.wav`);
    this.audio.play(AudioChannel.system, 0, false);
  }
  applyVolumes(): void {
    this.audio.setVolume(AudioChannel.voice, this.config(Config.voiceVolume));
    this.audio.setMusicVolume(this.config(Config.musicVolume));
    for (const channel of [AudioChannel.system, 2, 3, 4])
      this.audio.setVolume(channel, this.config(Config.soundVolume));
  }

  // Input from the host (window messages of the native game scene).

  private hit(x: number, y: number): RScriptNode | null {
    return this.display.screen.pick(x, y);
  }
  pointerMove(x: number, y: number): void {
    this.wake();
    Object.assign(this.pointer, {x, y});
    const pressed = this.pressed;
    if (pressed instanceof RScriptSprite && pressed.onDrag) {
      const origin = pressed.screenPosition();
      pressed.onDrag(pressed, {x: x - origin.x, y: y - origin.y});
      this.display.update();
      return;
    }
    const node = this.hit(x, y);
    if (node === this.hovered) return;
    if (this.hovered instanceof RScriptSprite) {
      this.hovered.hovered = false;
      this.hovered.onHover?.(this.hovered, false);
    }
    this.hovered = node;
    if (node instanceof RScriptSprite) {
      node.hovered = true;
      node.onHover?.(node, true);
    }
    this.display.update();
  }
  pointerDown(x: number, y: number): void {
    this.wake();
    Object.assign(this.pointer, {x, y});
    const node = this.hit(x, y);
    this.pressed = node;
    if (node instanceof RScriptSprite && node.onDrag) {
      const origin = node.screenPosition();
      node.onDrag(node, {x: x - origin.x, y: y - origin.y});
      this.display.update();
    }
  }
  /**
   * Left button up (WM_LBUTTONUP): a press on an interactive sprite, otherwise auto mode or
   * skipping stops, or the scene handles the click.
   */
  pointerUp(x: number, y: number): void {
    this.wake();
    Object.assign(this.pointer, {x, y});
    // A pointer wait takes the click before buttons and the scene (WM_LBUTTONUP).
    if (this.flags.buttonWait === 3) return this.buttonPressed(0, 1);
    const node = this.hit(x, y);
    const pressed = this.pressed;
    this.pressed = null;
    if (node && node === pressed && node instanceof RScriptSprite && node.onPress) {
      const origin = node.screenPosition();
      node.onPress(node, {x: x - origin.x, y: y - origin.y});
      this.display.update();
      return;
    }
    if (this.flags.auto) this.stopAuto();
    else if (this.flags.skip) this.flags.skipHeld = false;
    else this.click();
  }
  /** sub_41DEB0: a click restores the window, stops waits, leaves the backlog or resumes. */
  private click(): void {
    const {flags} = this;
    if (this.screens.open) return;
    if (flags.sleeping) flags.sleeping = false;
    else if (flags.windowHidden) this.showWindow();
    else if (flags.waitSound) {
      this.audio.stop(AudioChannel.effect, false);
      flags.waitSound = false;
    } else if (flags.waitVoice) {
      this.audio.stop(AudioChannel.voice, false);
      flags.waitVoice = false;
    } else if (this.message.browsing) {
      void this.message.exitBacklog().then(() => this.display.update());
    } else if (flags.waitClick) {
      flags.waitClick = false;
      this.resume();
    } else if (flags.waitAnimation) flags.completeAnimations = true;
  }
  /** Right button (WM_RBUTTONDOWN) and Escape during a wait. */
  cancel(): void {
    this.wake();
    const {flags} = this;
    if (this.screens.open) void this.closeScreen();
    else if (flags.windowHidden) this.showWindow();
    else if (flags.buttonWait && flags.buttonCancel) this.buttonPressed(0, 0);
    else this.panelCommand('menu');
  }
  /** Mouse wheel (WM_MOUSEWHEEL): up browses the backlog, down pages forward or clicks. */
  wheel(up: boolean): void {
    this.wake();
    if (this.screens.open) return;
    if (up) void this.message.backlogBack().then(() => this.display.update());
    else
      void this.message.backlogForward().then((handled) => {
        if (handled) this.display.update();
        else this.click();
      });
  }
  /** Control key held (485360): skipping starts at the next instruction. */
  setSkip(held: boolean): void {
    this.wake();
    if (!held) {
      this.flags.skipHeld = false;
      return;
    }
    if (this.flags.skip) return;
    this.flags.skipHeld = true;
    this.click();
  }
  /** Enter and space act like a left click; a skip in progress stops instead. */
  keyClick(): void {
    this.wake();
    if (this.flags.auto) this.stopAuto();
    else if (this.flags.skip) this.flags.skipHeld = false;
    else this.click();
  }
  /** Keyboard shortcuts of the game window (WM_KEYDOWN). */
  key(key: 'tab' | 'shift' | 'up' | 'down'): void {
    this.wake();
    if (key === 'tab') this.panelCommand('skip');
    else if (key === 'shift') this.panelCommand('hide');
    else this.wheel(key === 'up');
  }

  /** sub_41F200: loads slot 0 after a confirmation. */
  private async quickLoad(): Promise<void> {
    if (!(await this.readSlot(0))) return;
    if (!(await this.host.confirm(RScriptMessages.confirm, RScriptMessages.quickLoad))) return;
    await this.loadSlot(0);
  }

  /** sub_41F020 / sub_41F060: hides the message window until the next click. */
  private hideWindow(): void {
    this.message.show(false);
    this.flags.windowHidden = true;
    this.display.update();
  }
  private showWindow(): void {
    this.message.show(true);
    this.flags.windowHidden = false;
    this.display.update();
  }

  /** sub_41E010: after 100 idle input-wait ticks, auto-hide hides the cursor and window. */
  private idleTick(): void {
    if (!this.config(Config.autoHide) || this.idleHidden || this.screens.open) return;
    if (++this.idleTicks <= 100) return;
    this.idleHidden = true;
    this.host.setCursorVisible?.(false);
    this.message.show(false);
    this.display.update();
  }
  /** sub_41E070: input restores them, leaving a window the player hid hidden. */
  private wake(): void {
    this.idleTicks = 0;
    if (!this.idleHidden) return;
    this.idleHidden = false;
    this.host.setCursorVisible?.(true);
    if (!this.flags.windowHidden) this.message.show(true);
    this.display.update();
  }

  /** Companion panel commands (0x4176B0..0x4178C0 and the callbacks at +228..+276). */
  private panelCommand(command: PanelCommand): void {
    const {flags, message} = this;
    if (!message.inputActive) return;
    const state = (offset: number): boolean => message.dword(offset) !== 0;
    switch (command) {
      case 'skip':
        if (!state(MessageState.tabEnabled) || flags.skip) return;
        flags.skipHeld = true;
        this.click();
        return;
      case 'next':
        if (!state(MessageState.tabEnabled) || flags.buttonWait || flags.choice) return;
        this.audio.stopAll();
        flags.fastSkipRequest = true;
        this.click();
        return;
      case 'bak':
        this.wheel(true);
        return;
      case 'fow':
        this.wheel(false);
        return;
      case 'hide':
        this.hideWindow();
        return;
      case 'voc': {
        const {voice, pan} = message.currentVoice();
        if (voice) this.playVoice(voice, 0, false, pan);
        return;
      }
      case 'auto':
        message.autoHidden = true;
        message.updatePanel();
        if (flags.choice || flags.buttonWait) {
          message.restorePanel();
          return;
        }
        void message.exitBacklog().then(() => {
          this.display.update();
          flags.auto = true;
          this.click();
        });
        return;
      case 'extd':
        // The extra screen comes from an optional FlowDll.dll beside the executable.
        return;
      case 'rev':
        void this.returnToPreviousChoice();
        return;
      case 'qsave':
        this.playSystemSound(1);
        void this.saveSlot(0).catch((error: unknown) => this.fail(error));
        return;
      case 'qload':
        void this.quickLoad();
        return;
      case 'save':
      case 'load':
        void this.openSaveScreen(command === 'save');
        return;
      case 'menu':
        if (message.dword(MessageState.menuEnabled)) void this.openConfig();
        return;
      default:
        this.diagnostic(`The ${command} screen is not implemented yet`);
    }
  }

  /** sub_41EDF0: an answer resumes the waiting choice with the system decision sound. */
  private choiceAnswered(): void {
    if (!this.flags.choice) return;
    this.playSystemSound(1);
    this.flags.choice = false;
    this.resume();
  }

  /** Button callbacks by mode (0x41EE50, 0x41EEC0, 0x41EFD0). */
  private buttonPressed(mode: number, id: number): void {
    const {flags} = this;
    if (mode === 0) {
      if (!flags.buttonWait) return;
      flags.buttonWait = 0;
      if (flags.windowHidden) this.showWindow();
      this.memory.variables[0] = id;
      this.resume();
    } else if (mode === 1) {
      if (!flags.buttonWait) return;
      void this.nativeCommand(id);
    } else if (!flags.buttonTimer) {
      flags.buttonWait = 0;
      flags.interrupt = true;
      this.memory.variables[0] = id;
      this.resume();
    }
  }

  /** Mode-1 buttons (0x41EEC0): the engine's own screens and scene changes. */
  private async nativeCommand(id: number): Promise<void> {
    this.playSystemSound(1);
    switch (id) {
      case 0:
        return this.quit();
      case 1:
        await this.saveSystem();
        return this.returnToTitle();
      case 2:
        return this.openStandalone('load');
      case 3:
        return this.openStandalone('config');
      case 4:
        return this.openConfig();
      case 5:
        return this.openSaveScreen(false, true);
      case 6:
        return this.openSaveScreen(true, true);
      default:
        this.diagnostic(`Native screen ${id} is not implemented yet`);
    }
  }

  /** Timed button waits count down in hundredths of a second (word_4853A8, dword_4853AC). */
  private buttonTimer = {limit: 0, started: 0, elapsed: 0};
  startButtonTimer(limit: number): void {
    this.buttonTimer = {limit, started: this.host.timer.now(), elapsed: 0};
    this.flags.buttonTimer = true;
  }
  stopButtonTimer(): number {
    this.flags.buttonTimer = false;
    return this.buttonTimer.limit - this.buttonTimer.elapsed;
  }

  // Timer tick (sub_41E760).

  tick(): void {
    if (this.disposed) return;
    const {flags} = this;
    try {
      if (flags.buttonWait && flags.buttonTimer) {
        const timer = this.buttonTimer;
        timer.elapsed = Math.trunc((this.host.timer.now() - timer.started) / 10);
        if (timer.elapsed > timer.limit) {
          timer.elapsed = timer.limit;
          flags.buttonTimer = false;
          this.buttonPressed(0, 0);
        }
        return;
      }
      if (!flags.waitInput) {
        if (!flags.waitAnimation) return;
        for (const layer of this.layers) layer.tick();
        if (flags.completeAnimations) {
          this.message.finish();
          flags.completeAnimations = false;
        }
        const running = this.root.animate();
        this.display.update();
        if (!running) {
          flags.waitAnimation = false;
          this.resume();
        }
        return;
      }
      for (const layer of this.layers) layer.tick();
      this.message.tickWaiting();
      this.display.update();
      this.idleTick();
    } catch (error) {
      this.fail(error);
    }
  }

  // Saves (sub_421210, sub_4213D0, sub_421570).

  private slotName(slot: number, extension = 'dat'): string {
    return `${this.apini.savePrefix}${pad(slot, 2)}.${extension}`;
  }
  /** Writes the configuration, persistent variables and read flags. */
  saveSystem(): Promise<void> {
    return this.host.saves.write(`${this.apini.savePrefix}.dat`, encodeSystemSave(this.memory));
  }
  /** Saves the last message snapshot to a slot. */
  async saveSlot(slot: number): Promise<void> {
    const bytes = encodeSlotSave(this.memory, this.message.pageText, new Date());
    await this.host.saves.write(this.slotName(slot), bytes);
    // sub_41E980: the menu's scaled still, as a WCG beside the slot.
    const thumbnail = this.thumbnail;
    if (slot && thumbnail) {
      const pixels = new Uint8Array(thumbnail.data.buffer.slice(0));
      const wcg = encodeWcg({width: thumbnail.width, height: thumbnail.height, pixels});
      await this.host.saves.write(this.slotName(slot, 'wcg'), wcg);
    }
    await this.saveSystem();
  }
  readSlot(slot: number): Promise<Uint8Array | null> {
    return this.host.saves.read(this.slotName(slot));
  }
  /** Loads a slot and restarts the scene thread at the saved message. */
  async loadSlot(slot: number): Promise<boolean> {
    const bytes = await this.readSlot(slot);
    if (!bytes) return false;
    await this.restartScene(() => decodeSlotSave(this.memory, bytes));
    return true;
  }
  /** sub_421740 + sub_4535F0: returns to the snapshot before the previous choice. */
  returnToPreviousChoice(): Promise<void> {
    return this.restartScene(() => this.memory.restorePreviousSnapshot());
  }
  /** Returns to the title: the opening scene runs again. */
  returnToTitle(): Promise<void> {
    return this.restartScene(null);
  }

  // Native screens (0x41E0D0, 0x41E1E0, 0x41E360).

  /** Renders the scene into the backdrop and keeps a scaled copy for slot thumbnails. */
  private async captureBackdrop(): Promise<void> {
    this.display.update();
    const frame = this.display.frame;
    const still = createSurface(frame.width, frame.height);
    still.data.set(frame.data);
    const size = await this.thumbnailSize();
    this.thumbnail = size ? scaleStill(still, size.width, size.height) : null;
    if (!this.apini.u16(436)) {
      // sub_441A30(80): darkens by 80% through the CMath table row 255 * 80 / 100.
      for (let i = 0; i < still.data.length; i++)
        still.data[i] = scaleRgb(ADD_TABLE, 204, still.data[i]!);
    }
    this.backdrop.setSurface(still);
  }
  private thumbnailSizeCache: Promise<{width: number; height: number} | null> | null = null;
  /** The saveconf `thmb` layer's size (dword_4A287C, dword_4A2880). */
  private thumbnailSize(): Promise<{width: number; height: number} | null> {
    return (this.thumbnailSizeCache ??= (async () => {
      const path = `${this.apini.directories.system}\\saveconf`;
      const surface = (await this.images.lwg(path))?.find('thmb')
        ? await this.images.lwgLayer(path, 'thmb')
        : null;
      return surface ? {width: surface.width, height: surface.height} : null;
    })());
  }
  private async enterScreen(): Promise<void> {
    await this.captureBackdrop();
    this.screens.open = true;
    this.root.show(false);
    this.backdrop.show(true);
  }

  /** sub_41E0D0: the configuration screen over the scene (right button, panel menu). */
  async openConfig(): Promise<void> {
    if (this.screens.open) return;
    await this.enterScreen();
    this.screens.fromMenu = true;
    // Save and load appear when the script's panel settings allow them (scene 0x6C).
    this.configScreen.open(false, this.memory.sceneDword(0x6c) !== 0);
    this.display.update();
  }

  /** sub_41E1E0: the save or load screen over the scene; `resume` continues a button wait. */
  async openSaveScreen(save: boolean, resume = false): Promise<void> {
    if (this.screens.save) return;
    this.screens.save = true;
    if (this.screens.fromMenu) this.configScreen.close();
    else await this.enterScreen();
    this.screens.resume = resume;
    await this.saveScreen.open(save);
    this.display.update();
  }

  /** sub_41E360: closes the open screen, returning to the menu when it opened from there. */
  async closeScreen(): Promise<void> {
    const screens = this.screens;
    if (!screens.open) return;
    if (screens.standalone) return this.leaveStandalone();
    if (screens.save) {
      screens.save = false;
      this.saveScreen.close();
      if (screens.fromMenu) this.configScreen.open(false, this.memory.sceneDword(0x6c) !== 0);
      else {
        screens.open = false;
        this.backdrop.show(false);
        this.root.show(true);
      }
      if (screens.resume) {
        screens.resume = false;
        this.display.update();
        this.resume();
      }
    } else {
      screens.open = false;
      screens.fromMenu = false;
      this.configScreen.close();
      this.backdrop.show(false);
      this.root.show(true);
    }
    this.display.update();
  }
  private resetScreens(): void {
    Object.assign(this.screens, {
      open: false,
      save: false,
      fromMenu: false,
      resume: false,
      standalone: null,
    });
    this.saveScreen.close();
    this.configScreen.close();
    this.backdrop.show(false);
    this.root.show(true);
  }

  /** Buttons of the configuration screen (0x41EC30..0x41EC70, 0x41C050, 0x41B640). */
  private async configCommand(command: ConfigCommand): Promise<void> {
    if (command === 'exit') {
      this.playSystemSound(1);
      return this.quit();
    }
    this.playSystemSound(1);
    if (command === 'save' || command === 'load') return this.openSaveScreen(command === 'save');
    if (command === 'close' || this.screens.standalone) return this.closeScreen();
    if (await this.host.confirm(RScriptMessages.confirm, RScriptMessages.returnToTitle))
      await this.returnToTitle();
  }

  /** Side effects of configuration changes (0x41ED20, 0x41ECE0, 0x41ED90, 0x41EDD0). */
  private configChanged(change: ConfigChange): void {
    const memory = this.memory;
    switch (change) {
      case 'screen':
        this.host.setFullscreen?.(this.config(Config.screenMode) !== 0);
        break;
      case 'speed':
        this.message.setSpeed(this.config(Config.messageSpeed));
        break;
      case 'sound':
        if (!this.config(Config.soundEnabled)) {
          for (let channel = 0; channel < 3; channel++)
            this.audio.stop(AudioChannel.effect + channel, false);
          break;
        }
        // Looping effects start again.
        for (let channel = 0; channel < 3; channel++) {
          const base = Scene.soundChannels + channel * Scene.soundChannelStride;
          if (!memory.sceneUword(base + 2)) continue;
          this.loadSound(channel, memory.sceneUword(base));
          this.playSound(channel, 999, 0, memory.sceneWord(base + 4));
        }
        break;
      case 'music':
        if (this.config(Config.musicEnabled)) {
          const track = memory.sceneUword(Scene.music);
          if (track) this.playMusic(track, true, 0);
        } else this.audio.stopMusic(false, 0);
        break;
      case 'panel':
        this.message.updatePanel(this.config(0x16) !== 0);
        break;
      default:
        this.applyVolumes();
    }
  }

  /** sub_41EA70 (save) / sub_41EB60 (load) and the standalone load (sub_420200). */
  private async chooseSlot(slot: number, save: boolean): Promise<void> {
    const exists = !!(await this.readSlot(slot));
    const {confirm} = this.host;
    if (save) {
      this.playSystemSound(1);
      if (exists && !(await confirm(RScriptMessages.confirm, RScriptMessages.overwrite))) return;
      const previous = this.memory.configWord(0x3a) & 0xffff;
      this.memory.setConfigWord(0x3a, slot);
      await this.saveSlot(slot);
      if (previous !== slot) await this.saveScreen.refreshSlot(previous);
      await this.saveScreen.refreshSlot(slot);
      this.display.update();
      return;
    }
    if (!exists) return;
    if (!this.screens.standalone && !(await confirm(RScriptMessages.confirm, RScriptMessages.load)))
      return;
    this.playSystemSound(1);
    await this.loadSlot(slot);
  }

  /** The title's load and config buttons switch to standalone scenes (485306, 48530E). */
  private async openStandalone(kind: 'load' | 'config'): Promise<void> {
    await this.stopScene();
    this.screens.open = true;
    this.screens.standalone = kind;
    this.root.show(false);
    if (kind === 'load') await this.saveScreen.open(false);
    else this.configScreen.open(true, false);
    this.display.refresh();
  }
  /** Leaving a standalone scene returns to the game scene at the start script. */
  private async leaveStandalone(): Promise<void> {
    await this.saveSystem();
    this.resetScreens();
    this.startScene(() => this.newGame(this.apini.startScript));
  }

  /** WM_CLOSE of the game window: quits after the native confirmation. */
  async quit(): Promise<void> {
    if (!(await this.host.confirm(RScriptMessages.quitCaption, RScriptMessages.quit))) return;
    await this.saveSystem();
    this.dispose();
    this.host.exit();
  }

  // Lifecycle.

  /**
   * Stops the scene thread and starts it again: from the loaded state after `prepare`, or
   * from the opening when `prepare` is null (sub_4535F0, sub_41DF70).
   */
  private async restartScene(prepare: (() => void) | null): Promise<void> {
    await this.stopScene();
    if (prepare) {
      prepare();
      this.startScene(() => this.resumeScene());
    } else this.startScene(() => this.opening());
  }

  /** Unwinds the scene thread at its next wait and closes every screen. */
  private async stopScene(): Promise<void> {
    this.sceneGeneration++;
    this.vm.stop();
    this.host.stopMovie();
    this.flags.sleeping = false;
    this.audio.stopAll();
    this.event.set();
    await this.running;
    this.event.reset();
    Object.assign(this.flags, new RScriptFlags());
    this.nesting = 0;
    this.wake();
    this.resetScreens();
  }

  /** Runs a scene thread; when its script ends the opening scene takes over again. */
  private startScene(body: () => Promise<void>): void {
    const generation = this.sceneGeneration;
    this.running = body().then(
      () => {
        if (this.disposed || generation !== this.sceneGeneration) return;
        // The native thread posts 0x40F and the top-menu scene starts over.
        this.startScene(() => this.opening());
      },
      (error: unknown) => {
        if (!(error instanceof RScriptScriptEnd)) this.fail(error);
      },
    );
  }

  /** Loads the system save or defaults, then runs the opening and the start script. */
  async start(): Promise<void> {
    const {apini} = this.host;
    const saved = await this.host.saves.read(`${apini.savePrefix}.dat`);
    initializeConfig(this.memory, apini);
    if (saved) {
      try {
        decodeSystemSave(this.memory, saved);
      } catch (error) {
        this.diagnostic(
          `Ignoring unreadable ${apini.savePrefix}.dat: ${error instanceof Error ? error.message : error}`,
        );
        initializeConfig(this.memory, apini);
      }
    }
    // sub_456F60: the configured font becomes face 2, the one message boxes select.
    this.host.rasterizer.addFace(decodeCp932(this.memory.configString(Config.fontName, 52)));
    this.applyVolumes();
    this.display.refresh();
    this.ticker = setInterval(() => this.tick(), Math.max(1, apini.tickMilliseconds));
    await this.message.loadPanel();
    await this.saveScreen.load();
    await this.configScreen.load();
    this.startScene(() => this.opening());
  }

  /** The legacy top-menu scene opens with two movies before the configured start script. */
  private async opening(): Promise<void> {
    const {apini} = this.host;
    const generation = this.sceneGeneration;
    for (const movie of [2, 1]) {
      if (this.disposed || generation !== this.sceneGeneration) return;
      await this.host.playMovie(`${apini.directories.movies}\\${pad(movie, 4)}.mpg`);
    }
    if (generation !== this.sceneGeneration) return;
    if (!apini.skipTopMenu)
      this.diagnostic('The legacy top menu is not implemented; starting the script');
    await this.newGame(apini.startScript);
  }

  /** New game: default scene state, then the script at depth 0 (0x41DF70). */
  private async newGame(script: number): Promise<void> {
    initializeScene(this.memory, this.apini, true, this.vm.random.next());
    this.memory.variables.fill(0, 0, GAME_VARIABLE_COUNT);
    this.memory.setSceneWord(Scene.callDepth, 0);
    await this.prepareScene();
    await this.vm.load(script);
    this.vm.jump(0);
    await this.vm.run();
  }
  /** sub_41DF70: continues the loaded scene at its recorded instruction. */
  private async resumeScene(): Promise<void> {
    await this.prepareScene();
    await this.vm.resume();
    await this.rebuild();
    this.display.refresh();
    await this.vm.run();
  }
  private async prepareScene(): Promise<void> {
    this.message.setSpeed(this.config(Config.messageSpeed));
    this.message.setWindowAlpha(this.config(Config.windowAlpha));
    await this.rebuildObjects();
    this.display.refresh();
  }

  private fail(error: unknown): void {
    if (this.disposed || error instanceof RScriptScriptEnd) return;
    this.dispose();
    this.host.exit(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    this.vm.stop();
    this.flags.sleeping = false;
    this.event.set();
    this.audio.dispose();
  }
}

/**
 * sub_450060: nearest-neighbour shrink by whole percentages of the screen, in 16.16 steps
 * that divide by 0xFFFF like the native loop.
 */
function scaleStill(source: RScriptSurface, width: number, height: number): RScriptSurface {
  const percentX = Math.max(1, Math.trunc((100 * width) / source.width)),
    percentY = Math.max(1, Math.trunc((100 * height) / source.height));
  const stepX = Math.trunc(0x640000 / percentX),
    stepY = Math.trunc(0x640000 / percentY);
  const target = createSurface(
    Math.trunc((percentX * source.width) / 100),
    Math.trunc((percentY * source.height) / 100),
  );
  for (let y = 0, sy = 0; y < target.height; y++, sy += stepY) {
    const row = source.width * Math.trunc(sy / 0xffff);
    for (let x = 0, sx = 0; x < target.width; x++, sx += stepX)
      target.data[y * target.width + x] = source.data[row + Math.trunc(sx / 0xffff)]!;
  }
  return target;
}
