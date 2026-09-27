import {parseGsc, type GscProgram} from '../../../formats/rscript/gsc.js';
import type {RScriptApini} from '../apini.js';
import {initializeConfig, initializeScene} from '../defaults.js';
import type {RScriptFiles} from '../files.js';
import {createSurface, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite, type RScriptNode} from '../graphics/sprite.js';
import {RScriptImages} from '../images.js';
import {Config, GAME_VARIABLE_COUNT, Scene, RScriptMemory} from '../memory.js';
import {decodeSystemSave} from '../saves.js';
import {RSCRIPT_1_11_LAYOUTS} from '../vm/layouts.js';
import {
  RScriptInterpreter,
  RScriptScriptEnd,
  type RScriptNativeHandler,
} from '../vm/interpreter.js';
import {loadFrameAnimation} from './animation.js';
import {AudioChannel, RScriptAudio} from './audio.js';
import {RScriptDisplay, type RScriptPresenter, type RScriptTimer} from './display.js';
import {RScriptLayer} from './layer.js';
import {MessageState, RScriptMessageWindow} from './message-window.js';
import {createOpcodeHandlers} from './opcodes.js';
import type {GlyphRasterizer} from './text-block.js';

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
  /** Auto mode (485370). */
  auto = false;
  /** Kind of the active button wait: 1 buttons, 3 pointer (word_485384). */
  buttonWait = 0;
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
  wait(): Promise<void> {
    if (this.signaled) {
      this.signaled = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

const pad = (value: number, digits: number): string => String(value).padStart(digits, '0');

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
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

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
    });
    this.root.add(this.overlay, 1);
    this.root.add(this.effectScreen, 1);
    this.root.add(this.message, 50);
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
    await this.event.wait();
    if (this.disposed) throw new RScriptScriptEnd('stopped');
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
      this.setButtonInput(true, true);
      flags.waitClick = true;
      await this.suspend();
      flags.waitClick = false;
      this.setButtonInput(false, true);
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
      memory.scene.set(scene);
      memory.scene.set(backlog, backlogStart);
      Object.assign(this.vm, outer);
      this.nesting--;
    }
    await this.rebuild();
    return this.memory.variables[0]!;
  }
  private stopAuto(): void {
    if (!this.flags.auto) return;
    this.flags.auto = false;
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
    this.pressed = this.hit(x, y);
  }
  /** Left click (0x41DEB0) or a press on an interactive sprite. */
  pointerUp(x: number, y: number): void {
    const node = this.hit(x, y);
    const pressed = this.pressed;
    this.pressed = null;
    if (node && node === pressed && node instanceof RScriptSprite && node.onPress) {
      node.onPress(node);
      this.display.update();
      return;
    }
    this.click();
  }
  private click(): void {
    const {flags} = this;
    if (flags.sleeping) flags.sleeping = false;
    else if (flags.waitSound) {
      this.audio.stop(AudioChannel.effect, false);
      flags.waitSound = false;
    } else if (flags.waitVoice) {
      this.audio.stop(AudioChannel.voice, false);
      flags.waitVoice = false;
    } else if (flags.waitClick) {
      flags.waitClick = false;
      this.resume();
    } else if (flags.waitAnimation) flags.completeAnimations = true;
  }
  /** Control key or the panel skip button (485360); skipping stops at unread text. */
  setSkip(skip: boolean): void {
    this.flags.skipHeld = skip;
    this.flags.skip = skip;
    if (skip) {
      if (this.flags.waitAnimation) this.flags.completeAnimations = true;
      if (this.flags.waitClick) {
        this.flags.waitClick = false;
        this.resume();
      }
    }
  }
  /** Enter and space act like a left click. */
  keyClick(): void {
    this.click();
  }

  /** Button callbacks by mode (0x41EE50, 0x41EEC0, 0x41EFD0). */
  private buttonPressed(mode: number, id: number): void {
    const {flags} = this;
    if (mode === 0) {
      if (!flags.buttonWait) return;
      flags.buttonWait = 0;
      this.memory.variables[0] = id;
      this.resume();
    } else if (mode === 1) {
      if (!flags.buttonWait) return;
      this.diagnostic(`Native screen ${id} is not implemented yet`);
    } else if (!flags.buttonTimer) {
      flags.buttonWait = 0;
      flags.interrupt = true;
      this.memory.variables[0] = id;
      this.resume();
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
    } catch (error) {
      this.fail(error);
    }
  }

  // Lifecycle.

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
    this.applyVolumes();
    this.display.refresh();
    this.ticker = setInterval(() => this.tick(), Math.max(1, apini.tickMilliseconds));
    void this.run().catch((error: unknown) => this.fail(error));
  }

  private async run(): Promise<void> {
    const {apini} = this.host;
    // The legacy top-menu scene opens with two movies before the configured start script.
    for (const movie of [2, 1]) {
      if (this.disposed) return;
      await this.host.playMovie(`${apini.directories.movies}\\${pad(movie, 4)}.mpg`);
    }
    if (!apini.skipTopMenu)
      this.diagnostic('The legacy top menu is not implemented; starting the script');
    await this.newGame(apini.startScript);
  }

  /** New game: default scene state, then the script at depth 0 (0x41DF70). */
  async newGame(script: number): Promise<void> {
    initializeScene(this.memory, this.apini, true, this.vm.random.next());
    this.memory.variables.fill(0, 0, GAME_VARIABLE_COUNT);
    await this.rebuildObjects();
    this.message.setSpeed(this.config(Config.messageSpeed));
    this.display.refresh();
    this.memory.setSceneWord(Scene.callDepth, 0);
    await this.vm.load(script);
    this.vm.jump(0);
    await this.vm.run();
    if (!this.disposed) this.host.exit();
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
