import {byteDataView} from '../../core/binary.js';
import {RScriptBitsetStore} from './bitset-store.js';

/** Script-visible 16-bit variables (dword_4853B0, 0x4E20 bytes). */
export const VARIABLE_COUNT = 10000;
/** Variables 0..6999 belong to a play-through and are stored with each save slot. */
export const GAME_VARIABLE_COUNT = 7000;
/** Expression temporaries (word_4A2EA4); register 0 carries conditions. */
export const REGISTER_COUNT = 102;
/** Persistent configuration (dword_4853C0, 0x872 bytes written to the system save). */
export const CONFIG_SIZE = 0x872;
/** Scene state (word_485C34) that save slots and nested calls snapshot as a unit. */
export const SCENE_SIZE = 0x996c;

/** Offsets into the configuration block (relative to 0x4853C0). */
export const Config = {
  screenMode: 0x00,
  messageSpeed: 0x02,
  musicEnabled: 0x04,
  soundEnabled: 0x06,
  voiceEnabled: 0x08,
  musicVolume: 0x0a,
  soundVolume: 0x0c,
  voiceVolume: 0x0e,
  effectsEnabled: 0x12,
  skipUnread: 0x14,
  /** Message window opacity, 0..255 (the panel slider, sub_41F0D0). */
  windowAlpha: 0x1a,
  autoWait: 0x1e,
  voiceContinues: 0x20,
  /** Hides the cursor and message window while idle (sub_41E010). */
  autoHide: 0x22,
  /** Per voice-bank enable flags, indexed by voice id / 10000. */
  voiceBanks: 0x24,
  systemWords: 0x3c,
  systemWordsB: 0x50,
  systemStrings: 0x64,
  /** The message font (`String`, 52 bytes to the end of the block). */
  fontName: 0x83e,
} as const;

/** Offsets into the scene state (relative to 0x485C34). */
export const Scene = {
  music: 0x0000,
  soundChannels: 0x0004,
  soundChannelStride: 6,
  randomSeed: 0x001c,
  scriptStack: 0x001e,
  returnStack: 0x0034,
  callDepth: 0x005c,
  effectImage: 0x005e,
  effectBlend: 0x0060,
  effectOrder: 0x0062,
  overlayPercent: 0x0064,
  overlayBlend: 0x0066,
  overlayOrder: 0x0068,
  messageSnapshots: 0x0070,
  autoRebuild: 0x0074,
  layerAnimationReset: 0x0078,
  messageMode: 0x007c,
  layers: 0x0080,
  layerStride: 200,
  layerCount: 100,
  layerOrders: 0x4ea0,
  layerGroups: 0x4f68,
  gauges: 0x5030,
  gaugeStride: 52,
  gaugeCount: 10,
  coordinateScaleX: 0x5238,
  coordinateScaleY: 0x523a,
  message: 0x523c,
  stringRegisters: 0x8c60,
  stringStride: 201,
  stringRegisterFlags: 0x943a,
  selection: 0x9464,
  words: 0x9942,
  wordsB: 0x9956,
} as const;

/** 200-byte layer record (sub_406F80 binds dword_485CB4 + 200 * index). */
export const LayerRecord = {
  x: 0,
  y: 4,
  kind: 8,
  source: 10,
  pattern: 12,
  image: 14,
  color: 16,
  loadFlags: 20,
  blendMode: 22,
  blendValue: 24,
  clip: 26,
  visible: 36,
  centerX: 40,
  centerY: 44,
  keepOnScreen: 48,
  animating: 52,
  animationSpeed: 56,
  animationMode: 58,
  overlays: 60,
  animationStep: 66,
  overlayPositions: 68,
  priority: 92,
  animationFrames: 94,
  name: 96,
  directory: 177,
} as const;

/** All engine memory that script code, saves and native screens share. */
export class RScriptMemory {
  readonly variables = new Int16Array(VARIABLE_COUNT);
  readonly registers = new Int16Array(REGISTER_COUNT);
  readonly config = new Uint8Array(CONFIG_SIZE + 2);
  readonly scene = new Uint8Array(SCENE_SIZE);
  /** State at the last message snapshot point (unk_48F5A0 / lpBuffer). */
  readonly messageScene = new Uint8Array(SCENE_SIZE);
  readonly messageVariables = new Int16Array(GAME_VARIABLE_COUNT);
  /** Previous snapshot kept for "return to previous choice" (unk_498F0C / dword_4853B8). */
  readonly previousScene = new Uint8Array(SCENE_SIZE);
  readonly previousVariables = new Int16Array(GAME_VARIABLE_COUNT);
  /** Read-text flags by (script, text) and seen images (dword_4852F8 / dword_4852FC). */
  readonly readText = new RScriptBitsetStore();
  readonly seenImages = new RScriptBitsetStore();
  readonly configView = byteDataView(this.config);
  readonly sceneView = byteDataView(this.scene);

  configWord(offset: number): number {
    return this.configView.getInt16(offset, true);
  }
  setConfigWord(offset: number, value: number): void {
    this.configView.setInt16(offset, value, true);
  }
  sceneWord(offset: number): number {
    return this.sceneView.getInt16(offset, true);
  }
  sceneUword(offset: number): number {
    return this.sceneView.getUint16(offset, true);
  }
  setSceneWord(offset: number, value: number): void {
    this.sceneView.setInt16(offset, value, true);
  }
  sceneDword(offset: number): number {
    return this.sceneView.getInt32(offset, true);
  }
  setSceneDword(offset: number, value: number): void {
    this.sceneView.setInt32(offset, value, true);
  }

  /** Reads a NUL-terminated Shift-JIS field without decoding it. */
  sceneString(offset: number, capacity: number): Uint8Array {
    const field = this.scene.subarray(offset, offset + capacity);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? capacity : end);
  }
  setSceneString(offset: number, capacity: number, value: Uint8Array): void {
    const length = Math.min(value.length, capacity - 1);
    this.scene.fill(0, offset, offset + capacity);
    this.scene.set(value.subarray(0, length), offset);
  }
  configString(offset: number, capacity: number): Uint8Array {
    const field = this.config.subarray(offset, offset + capacity);
    const end = field.indexOf(0);
    return field.subarray(0, end < 0 ? capacity : end);
  }
  setConfigString(offset: number, capacity: number, value: Uint8Array): void {
    const length = Math.min(value.length, capacity - 1);
    this.config.fill(0, offset, offset + capacity);
    this.config.set(value.subarray(0, length), offset);
  }

  /** sub_421390: remembers the state at a message boundary unless a nested call runs. */
  captureMessageSnapshot(): void {
    this.messageScene.set(this.scene);
    this.messageVariables.set(this.variables.subarray(0, GAME_VARIABLE_COUNT));
  }
  /** sub_421700: promotes the message snapshot to the previous-choice snapshot. */
  promoteMessageSnapshot(): void {
    this.previousScene.set(this.messageScene);
    this.previousVariables.set(this.messageVariables);
  }
  /** sub_421740: returns to the previous-choice snapshot. */
  restorePreviousSnapshot(): void {
    this.scene.set(this.previousScene);
    this.variables.set(this.previousVariables);
  }
  /** sub_420FC0 with a nonzero argument clears play-through memory first. */
  clearPlaythrough(): void {
    this.scene.fill(0);
    this.variables.fill(0, 0, GAME_VARIABLE_COUNT);
  }
}
