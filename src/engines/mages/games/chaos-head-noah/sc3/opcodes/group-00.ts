import {
  indexedJump,
  copyFlag,
  queryLoaderResult,
  disableTextureRequests,
  setSceneValue,
} from './state-commands.js';
import {loadSystemData} from './system-data.js';
import {systemMenu} from './system-menu.js';
import {requestApplicationExit} from './exit.js';
import {replaceScript} from './replace-script.js';
import {scaledWait} from './scaled-wait.js';
import {copyContext} from './copy-context.js';
import {controlContextGroup} from './context-group.js';
import {platformBranch} from './platform-branch.js';
import {uiSound} from './ui-sound.js';
import {audioSetting} from './audio-setting.js';
import {
  pauseSceneAudio,
  pairedMusic,
  requestMusic,
  stopAudioChannel,
  stopMusic,
  stopSound,
  waitSound,
  requestSound,
} from './music.js';
import {requestAudioChannel} from './request-audio.js';
import {countedLoop} from './loop.js';
import {inputJump, inputMaskJump} from './input.js';
import {queryState} from './query-state.js';
import {applyInputSettings} from './input-settings.js';
import {saveCommand} from './save.js';
import {checkRange} from '../../../../../../core/binary.js';
import {messageBox} from './message-box.js';
import {switchLanguage} from './language.js';
import type {OpcodeExecution, OpcodeGroup, OpcodeHandler} from './types.js';

function transfer(opcode: number): (h: OpcodeExecution) => void {
  return (h) => {
    const c = h.context;
    h.skip(2);
    let targetSlot = c.getUint32(0x74, true),
      polarity = 0,
      value = 0;
    if (opcode === 0x0c || opcode === 0x0d) targetSlot = h.expression() >>> 0;
    if (opcode === 0x0a) {
      polarity = h.byte();
      value = h.expression();
      targetSlot = c.getUint32(0x74, true);
    }
    // Native resolves the label even for an untaken branch or a full call stack.
    const target = h.labelAddress(targetSlot, h.word());
    if (opcode === 0x0b || opcode === 0x0d) {
      const returnLabel = h.word(),
        depth = c.getInt32(0x2c, true);
      checkRange(9, depth, 1);
      if (depth !== 8) {
        c.setUint32(0x30 + depth * 4, returnLabel, true);
        c.setUint32(0x50 + depth * 4, c.getUint32(0x74, true), true);
        c.setInt32(0x2c, depth + 1, true);
        c.setBigUint64(0x158, BigInt(target), true);
        if (opcode === 0x0d) c.setUint32(0x74, targetSlot, true);
      }
    } else if (opcode !== 0x0a || (polarity === 0 ? value === 0 : value !== 0)) {
      c.setBigUint64(0x158, BigInt(target), true);
      if (opcode === 0x0c) c.setUint32(0x74, targetSlot, true);
    }
  };
}
const handlers: [number, OpcodeHandler][] = [
  [0x44, {name: 'in-game system menu', native: '140056040', execute: systemMenu}],
  [0x08, {name: 'indexed label jump', native: '1400524f0', execute: indexedJump}],
  [0x14, {name: 'copy flag', native: '140052d50', execute: copyFlag}],
  [0x30, {name: 'query loader result', native: '140054ce0', execute: queryLoaderResult}],
  [0x3f, {name: 'disable texture requests', native: '140055c20', execute: disableTextureRequests}],
  [0x42, {name: 'set scene value', native: '140055c60', execute: setSceneValue}],
  [0x34, {name: 'request application exit', native: '140055150', execute: requestApplicationExit}],
  [0x3a, {name: 'paired music', native: '140055410', execute: pairedMusic}],
  [0x3b, {name: 'pause scene audio', native: '1400556e0', execute: pauseSceneAudio}],
  [0x1b, {name: 'replace current script/messages', native: '140053320', execute: replaceScript}],
  [0x4c, {name: 'scaled scene wait', native: '140056660', execute: scaledWait}],
  [
    0x2f,
    {
      name: 'unlock achievement',
      native: '140054c60',
      execute(h) {
        h.skip(2);
        if (h.byte() === 1) h.achievement(h.expression() >>> 0);
      },
    },
  ],
  [
    0x2c,
    {
      name: 'unlock music entry',
      native: '140054ba0',
      execute(h) {
        h.skip(2);
        const index = h.expression();
        h.state.put(0x17acbd0 + index, 1, 1);
      },
    },
  ],
  [0x19, {name: 'control context group', native: '1400531d0', execute: controlContextGroup}],
  [0x28, {name: 'copy context locals', native: '140054530', execute: copyContext}],
  [0x39, {name: 'wait sound', native: '140055380', execute: waitSound}],
  [0x37, {name: 'request sound', native: '1400551b0', execute: requestSound}],
  [0x46, {name: 'query native state', native: '1400560f0', execute: queryState}],
  [0x15, {name: 'input mask conditional jump', native: '140052e00', execute: inputMaskJump}],
  [0x50, {name: 'platform conditional branch', native: '140056820', execute: platformBranch}],
  [0x26, {name: 'system sound', native: '1400543d0', execute: uiSound}],
  [0x2e, {name: 'audio setting', native: '140054bf0', execute: audioSetting}],
  [0x21, {name: 'request music', native: '140053890', execute: requestMusic}],
  [0x22, {name: 'stop music', native: '140053ca0', execute: stopMusic}],
  [0x23, {name: 'request audio channel', native: '140053da0', execute: requestAudioChannel}],
  [0x24, {name: 'stop audio channel', native: '140054080', execute: stopAudioChannel}],
  [0x38, {name: 'stop sound', native: '140055280', execute: stopSound}],
  [
    0x3e,
    {
      name: 'reset audio channels',
      native: '140055c10',
      execute(h) {
        h.skip(2);
        h.resetAudio();
      },
    },
  ],
  [0x31, {name: 'load system data', native: '140054d00', execute: loadSystemData}],
  [0x0f, {name: 'counted loop', native: '1400529d0', execute: countedLoop}],
  [0x53, {name: 'input conditional jump', native: '1400569d0', execute: inputJump}],
  [0x43, {name: 'message box', native: '140055cb0', execute: messageBox}],
  [0x5e, {name: 'switch language', native: '140056f70', execute: switchLanguage}],
  [
    0x00,
    {
      name: 'end context',
      native: '140051d60',
      execute(h) {
        h.context.setUint32(0, 0x08000000, true);
        h.yield();
      },
    },
  ],
  [
    0x01,
    {
      name: 'spawn context',
      native: '140051d80',
      execute(h) {
        h.state.put(0x17a0c8c, h.state.get(0x17a0c8c) + 1);
        h.skip(2);
        const group = h.expression(),
          slot = h.expression() >>> 0;
        const pc = Number(h.context.getBigUint64(0x158, true));
        const label = h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8);
        const target = h.labelAddress(slot, label);
        h.skip(2);
        h.spawn(group, slot, target);
      },
    },
  ],
  [
    0x18,
    {
      name: 'write context word',
      native: '140053170',
      execute(h) {
        h.skip(2);
        const index = h.expression(),
          value = h.expression();
        checkRange(h.context.byteLength, index * 4, 4);
        h.context.setInt32(index * 4, value, true);
      },
    },
  ],
  [
    0x1a,
    {
      name: 'complete linked context',
      native: '140053300',
      execute(h) {
        h.skip(2);
        h.context.setInt32(0x1c, (h.context.getUint32(0x70, true) - 0x80000000) | 0, true);
      },
    },
  ],
  [
    0x1f,
    {
      name: 'store branch value',
      native: '1400537b0',
      execute(h) {
        h.skip(2);
        h.state.put(0x179e6f8, h.expression());
      },
    },
  ],
  [
    0x20,
    {
      name: 'jump if branch value equals',
      native: '1400537d0',
      execute(h) {
        h.skip(2);
        const value = h.expression(),
          slot = h.context.getUint32(0x74, true);
        const target = h.labelAddress(slot, h.word());
        if (value === h.state.get(0x179e6f8)) h.context.setBigUint64(0x158, BigInt(target), true);
      },
    },
  ],
  [
    0x06,
    {
      name: 'suspend context',
      native: '140052460',
      execute(h) {
        h.context.setUint32(0, h.context.getUint32(0, true) | 0x40000000, true);
        h.yield();
      },
    },
  ],
  [
    0x03,
    {
      name: 'yield',
      native: '140051f10',
      execute(h) {
        h.skip(2);
        h.yield();
      },
    },
  ],
  [
    0x04,
    {
      name: 'load script/messages',
      native: '140051f30',
      execute(h) {
        h.skip(2);
        const mode = h.byte(),
          slot = h.expression(),
          asset = h.expression();
        if (h.loadScripts(mode, slot, asset)) h.retry();
      },
    },
  ],
  [
    0x05,
    {
      name: 'wait frames',
      native: '1400523e0',
      execute(h) {
        h.skip(2);
        const delay = h.expression() & 0x3ff,
          counter = h.context.getInt32(0x18, true);
        const remaining = counter < 1 ? delay : counter - 1;
        h.context.setInt32(0x18, remaining, true);
        if (remaining > 0) h.retry();
      },
    },
  ],
  [
    0x33,
    {
      name: 'wait frames with skip value',
      native: '1400550b0',
      execute(h) {
        const c = h.context,
          s = h.state;
        h.skip(2);
        const delay = h.expression() & 0x3ff;
        h.expression();
        const counter = c.getInt32(0x18, true),
          remaining = counter < 1 ? delay : counter - 1;
        c.setInt32(0x18, remaining, true);
        if (s.get(0x17ac374) !== 0) c.setInt32(0x18, 0, true);
        else if (remaining > 0) h.retry();
      },
    },
  ],
  [0x07, {name: 'jump', native: '140052480', execute: transfer(0x07)}],
  [0x0a, {name: 'conditional jump', native: '140052600', execute: transfer(0x0a)}],
  [0x0b, {name: 'call', native: '1400526e0', execute: transfer(0x0b)}],
  [0x0c, {name: 'jump', native: '1400527a0', execute: transfer(0x0c)}],
  [0x0d, {name: 'call', native: '140052840', execute: transfer(0x0d)}],
  [
    0x0e,
    {
      name: 'return',
      native: '140052930',
      execute(h) {
        const c = h.context,
          depth = c.getInt32(0x2c, true);
        checkRange(9, depth, 1);
        if (depth !== 0) {
          c.setInt32(0x2c, depth - 1, true);
          const label = c.getUint32(0x30 + (depth - 1) * 4, true);
          const slot = c.getUint32(0x50 + (depth - 1) * 4, true);
          c.setBigUint64(0x158, BigInt(h.labelAddress(slot, label, true)), true);
          c.setUint32(0x74, slot, true);
        }
      },
    },
  ],
  [
    0x11,
    {
      name: 'wait while flag equals',
      native: '140052bc0',
      execute(h) {
        h.skip(2);
        const expected = h.byte(),
          index = h.expression() >>> 0;
        if (h.state.flag(index) === expected) h.retry();
      },
    },
  ],
  [
    0x10,
    {
      name: 'jump if flag equals',
      native: '140052ac0',
      execute(h) {
        h.skip(2);
        const expected = h.byte(),
          index = h.expression() >>> 0,
          slot = h.context.getUint32(0x74, true);
        const target = h.labelAddress(slot, h.word());
        if (h.state.flag(index) === expected) h.context.setBigUint64(0x158, BigInt(target), true);
      },
    },
  ],
  [
    0x12,
    {
      name: 'set flag',
      native: '140052c70',
      execute(h) {
        h.skip(2);
        const index = h.expression();
        if (index >= 0) h.state.setFlag(index, 1);
      },
    },
  ],
  [
    0x13,
    {
      name: 'clear flag',
      native: '140052ce0',
      execute(h) {
        h.skip(2);
        const index = h.expression();
        if (index >= 0) h.state.setFlag(index, 0);
      },
    },
  ],
  [
    0x25,
    {
      name: 'set view offsets',
      native: '140054350',
      execute(h) {
        h.skip(2);
        h.expression();
        const x = h.expression(),
          y = h.expression();
        h.state.setVariable(0x3444 / 4, x);
        h.state.setVariable(0x3448 / 4, y);
      },
    },
  ],
  [0x32, {name: 'apply input settings', native: '140054f30', execute: applyInputSettings}],
  [0x2a, {name: 'save system', native: '140054610', execute: saveCommand}],
  [
    0x29,
    {
      name: 'native ignored byte command',
      native: '140054600',
      execute(h) {
        h.skip(3);
      },
    },
  ],
  [
    0x4b,
    {
      name: 'native ignored byte command',
      native: '140054600',
      execute(h) {
        h.skip(3);
      },
    },
  ],
];
export const group00: OpcodeGroup = new Map(handlers);
