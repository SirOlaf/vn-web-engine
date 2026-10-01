import type {RScriptApini} from './apini.js';
import {Config, LayerRecord, Scene, type RScriptMemory} from './memory.js';
import {BoxRecord} from './runtime/text-box.js';
import {MessageState} from './runtime/message-window.js';

/** sub_420EC0 (1.9: sub_419BB0, the same values): defaults used when no system save exists. */
export function initializeConfig(memory: RScriptMemory, apini: RScriptApini): void {
  memory.config.fill(0);
  memory.variables.fill(0, 7000);
  const set = (offset: number, value: number): void => memory.setConfigWord(offset, value);
  set(Config.messageSpeed, 1);
  set(Config.musicEnabled, 1);
  set(Config.soundEnabled, 1);
  set(Config.voiceEnabled, 1);
  set(Config.musicVolume, 255);
  set(Config.soundVolume, 255);
  set(Config.voiceVolume, 255);
  set(Config.effectsEnabled, 1);
  set(0x1c, 1);
  set(Config.windowAlpha, 128);
  set(Config.autoWait, 1500);
  for (let bank = 0; bank < 10; bank++) set(Config.voiceBanks + 2 * bank, 1);
  memory.setConfigString(Config.fontName, 52, apini.fontNameBytes);
}

/**
 * sub_420FC0: new-game scene state. With `clear`, the scene and play-through variables are
 * zeroed first; the native seeds the script random word from the system clock.
 */
export function initializeScene(
  memory: RScriptMemory,
  apini: RScriptApini,
  clear: boolean,
  seed: number,
): void {
  if (clear) memory.clearPlaythrough();
  // 1.9 (sub_419CC0) sets the same defaults on the fields its records have.
  const dword = (offset: number, value: number): void => {
    if (memory.hasSceneField(offset)) memory.setSceneDword(offset, value);
  };
  const word = (offset: number, value: number): void => {
    if (memory.hasSceneField(offset)) memory.setSceneWord(offset, value);
  };
  dword(0x6c, 1);
  dword(Scene.messageSnapshots, 1);
  dword(Scene.autoRebuild, 1);
  dword(Scene.layerAnimationReset, 1);
  word(Scene.randomSeed, seed);

  for (let box = 0; box < 4; box++) {
    const r = Scene.message + MessageState.boxes + box * MessageState.boxStride;
    const b = BoxRecord;
    word(r + b.frame, 0);
    word(r + b.waitIcon, 0);
    dword(r + b.glow, 0xffff80);
    dword(r + b.x, 50);
    dword(r + b.y, 340);
    dword(r + b.waitX, 200);
    dword(r + b.waitY, 20);
    dword(r + b.textX, 30);
    dword(r + b.textY, 20);
    dword(r + b.textWidth, 504);
    dword(r + b.textHeight, 90);
    word(r + b.indent, 0);
    word(r + b.firstIndent, 0);
    word(r + b.size, 24);
    dword(r + b.color, 0xffffff);
    dword(r + b.waitEnabled, 1);
    dword(r + b.visible, 0);
    word(r + b.rubySize, 6);
    word(r + b.rubyRaise, 6);
    word(r + b.lineSpacing, 5);
    word(r + b.charSpacing, 0);
  }
  const message = (offset: number): number => Scene.message + offset;
  dword(message(MessageState.panelX), 397);
  dword(message(MessageState.panelY), 343);
  dword(message(MessageState.panelEnabled), 0);
  dword(message(MessageState.menuEnabled), 1);
  dword(message(MessageState.backlogEnabled), 1);
  dword(message(MessageState.tabEnabled), 1);
  word(message(MessageState.faceOrder), 10);

  const sprites = apini.spriteDirectoryBytes,
    events = apini.eventDirectoryBytes;
  for (let layer = 0; layer < Scene.layerCount; layer++) {
    const r = Scene.layers + layer * Scene.layerStride;
    word(r + LayerRecord.image, 0);
    dword(r + LayerRecord.visible, 1);
    word(Scene.layerOrders + 2 * layer, layer);
    word(Scene.layerGroups + 2 * layer, 1);
    word(r + LayerRecord.blendMode, 0);
    dword(r + LayerRecord.centerX, 1);
    dword(r + LayerRecord.centerY, 1);
    word(r + LayerRecord.priority, 30);
    word(r + LayerRecord.kind, apini.defaultLayerKind);
    memory.setSceneString(r + LayerRecord.directory, 23, sprites);
  }
  // Layer 0 is the background: top-left anchored, no blend, event image directory.
  dword(Scene.layers + LayerRecord.centerX, 0);
  dword(Scene.layers + LayerRecord.centerY, 0);
  word(Scene.layers + LayerRecord.blendMode, 99);
  word(Scene.layers + LayerRecord.kind, 0);
  word(Scene.layerGroups, 0);
  memory.setSceneString(Scene.layers + LayerRecord.directory, 23, events);
  word(Scene.coordinateScaleX, 1);
  word(Scene.coordinateScaleY, 1);
  for (let register = 0; register < 10; register++) {
    memory.setSceneByte(Scene.stringRegisters + register * Scene.stringStride, 0);
    memory.setSceneByte(Scene.stringRegisterFlags + 4 * register, 4);
  }
}
