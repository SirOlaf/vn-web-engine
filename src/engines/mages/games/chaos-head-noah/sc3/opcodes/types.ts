import type {TextureLoader} from '../texture-load.js';
import type {NoahTips} from '../tips.js';
import type {NoahState} from '../noah-state.js';
import type {MessageBoxes} from '../message-boxes.js';
import type {SaveStorage} from '../save-storage.js';

/** Per-invocation capabilities. Groups do not own the runtime or its dispatch loop. */
export interface OpcodeExecution {
  readonly scriptBuffers: import('../script-load.js').ScriptBufferHost;
  readonly movies: import('../movie-devices.js').NoahMovieDevices;
  readonly sceneText: import('../scene-text.js').SceneText;
  messageIndex(slot: number, id: number): number;
  readonly backlog: import('../backlog-text.js').BacklogText;
  achievement(id: number): void;
  readonly characterAssets: import('../raw-assets.js').RawAssets;
  readonly rawAssets: import('../raw-assets.js').RawAssets;
  readonly input: import('../input.js').NoahInput;
  readonly state: NoahState;
  readonly tips: NoahTips;
  readonly messageBoxes: MessageBoxes;
  readonly storage: SaveStorage;
  sound(id: number, volume: number): void;
  resumeAudio(channel: number): void;
  pauseAudio(channel: number, paused: boolean): void;
  /** Noah application +0x1a5; consumed by the next host input pump. */
  requestExit(): void;
  resetAudio(): void;
  stopAudioDevice(channel: number): void;
  localTime(): Date;
  uploadThumbnail(id: number, bytes: Uint8Array): void;
  /** Selected native manual CPK file count, supplied by the archive backend. */
  manualPageCount(): number;
  readonly language: number;
  setLanguage(language: number): void;
  readonly context: DataView;
  readonly configEnabled: boolean;
  readonly backgroundTextures: TextureLoader;
  readonly textures: {
    start(bank: number, asset: number): number;
    upload(target: number, pointer: number, size: number): void;
    release(target: number): void;
  };
  skip(bytes: number): void;
  byte(): number;
  word(): number;
  expression(): number;
  /** Evaluate an embedded scene expression with the native temporary context. */
  textExpression(address: number): number;
  labelAddress(slot: number, label: number, returnTable?: boolean): number;
  stringAddress(slot: number, label: number): number;
  messageAddress(slot: number, id: number): number;
  scriptByte(pointer: number): number;
  loadScripts(mode: number, slot: number, asset: number): boolean;
  spawn(group: number, slot: number, address: number): void;
  yield(): void;
  retry(): void;
}
export interface OpcodeHandler {
  readonly name: string;
  readonly native: string;
  execute(invocation: OpcodeExecution): void | Promise<void>;
}
export type OpcodeGroup = ReadonlyMap<number, OpcodeHandler>;
