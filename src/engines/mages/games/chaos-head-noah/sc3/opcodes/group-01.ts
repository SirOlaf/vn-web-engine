import {backlog} from './backlog.js';
import {createSurface} from './create-surface.js';
import {pauseSceneMovie} from './state-commands.js';
import {menuChoice} from './menu-choice.js';
import type {OpcodeGroup} from './types.js';
import {textSlotControl} from './text-slot-control.js';
import {releaseSurface} from './release-surface.js';
import {mathCommand} from './math.js';
import {message} from './message.js';
import {waitMessage} from './message-wait.js';
import {selectText, beginText} from './text-selection.js';
import {clearText} from './clear-text.js';
import {history} from './history.js';
import {movieStart} from './movie-start.js';
import {movieControl} from './movie-control.js';
import {controlSceneMessages} from './scene-message-control.js';
import {sceneChoice} from './scene-choice.js';
import {controlSceneChoice} from './scene-choice-control.js';
/** Graphics/media group. Only audited complete opcode state machines are registered. */
export const group01: OpcodeGroup = new Map([
  [0x10, {name: 'backlog', native: '14004ee30', execute: backlog}],
  [0x00, {name: 'create surface', native: '14004aa10', execute: createSurface}],
  [0x14, {name: 'prepare menu choice', native: '140050120', execute: menuChoice}],
  [0x27, {name: 'pause scene movie', native: '140051520', execute: pauseSceneMovie}],
  [0x08, {name: 'control scene messages', native: '14004c670', execute: controlSceneMessages}],
  [0x12, {name: 'prepare scene choice', native: '14004f2c0', execute: sceneChoice}],
  [0x13, {name: 'control scene choice', native: '14004f640', execute: controlSceneChoice}],
  [0x22, {name: 'start movie', native: '140050850', execute: movieStart}],
  [0x23, {name: 'movie control', native: '140050ca0', execute: movieControl}],
  [0x25, {name: 'append history text', native: '140051110', execute: history}],
  [0x0a, {name: 'clear scene text', native: '14004cdf0', execute: clearText}],
  [0x0c, {name: 'prepare scene message', native: '14004d740', execute: message}],
  [0x0d, {name: 'wait scene message', native: '14004e040', execute: waitMessage}],
  [0x09, {name: 'select text slot', native: '14004ccd0', execute: selectText}],
  [0x0b, {name: 'begin text block', native: '14004d590', execute: beginText}],
  [0x05, {name: 'native math', native: '14004ade0', execute: mathCommand}],
  [0x01, {name: 'release surface', native: '14004aae0', execute: releaseSurface}],
  [0x11, {name: 'text slot control', native: '14004ef60', execute: textSlotControl}],
  [
    0x21,
    {
      name: 'bind script data table',
      native: '140050770',
      execute(h) {
        h.skip(2);
        const index = h.expression(),
          slot = h.context.getUint32(0x74, true);
        const pc = Number(h.context.getBigUint64(0x158, true));
        const label = h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8);
        h.state.put(0x17adc60 + index * 4, slot);
        const address = h.labelAddress(slot, label);
        h.skip(2);
        h.state.put(0x17ac320 + index * 8, address, 8);
        h.state.put(
          0x17acba8 + index * 4,
          h.scriptByte(address) | (h.scriptByte(address + 1) << 8),
        );
      },
    },
  ],
  [
    0x02,
    {
      name: 'load texture',
      native: '14004ab50',
      execute(h) {
        const s = h.state;
        if (s.get(0x81007c) !== 0) {
          h.yield();
          return;
        }
        h.skip(2);
        const target = h.expression(),
          bank = h.expression(),
          asset = h.expression();
        const phase = s.get(0x176e528),
          count = (n: number) => s.setVariable(0x3404 / 4, s.variable(0x3404 / 4) + n);
        if (phase === 0) {
          if (s.variable(0x3394 / 4) === 0) {
            if (s.flags[0xe7]! & 4) return;
            // Native deliberately ignores both busy and start-error return codes.
            h.textures.start(bank, asset);
            s.put(0x176e528, 1);
            count(1);
            s.setVariable(0x3394 / 4, 1);
          }
        } else if (phase === 1) {
          if (s.get(0x5872ac) === 0) {
            const size = s.get(0x58726c),
              pointer = Number(s.view(0x587338, 8).getBigUint64(0, true));
            s.put(0x587338, 0, 8);
            s.put(0x58726c, 0);
            s.put(0x5872ac, 0);
            s.put(0x179cd20, size);
            s.put(0x179cd28, pointer, 8);
            h.textures.upload(target, pointer, size);
            s.put(0x176e528, 8);
          }
        } else if (phase === 2 || phase === 8) {
          s.put(0x176e528, 0);
          s.setVariable(0x3394 / 4, 0);
          if (phase === 8) s.flags[0x98] = s.flags[0x98]! & ~0x40;
          count(-1);
          return;
        }
        h.retry();
      },
    },
  ],
  [
    0x0e,
    {
      name: 'define font',
      native: '14004eb90',
      execute(h) {
        h.skip(2);
        const index = h.expression() >>> 0,
          slot = h.context.getUint32(0x74, true);
        const address = h.labelAddress(slot, h.word());
        // 14003e7d0: 24 ordered little-endian halfword writes, no context result write.
        for (let i = 0; i < 48; i += 2)
          h.state.put(
            0x7fbd80 + index * 48 + i,
            h.scriptByte(address + i) | (h.scriptByte(address + i + 1) << 8),
            2,
          );
      },
    },
  ],
  [
    0x0f,
    {
      name: 'set text character tables',
      native: '14004ec40',
      execute(h) {
        h.skip(2);
        const first = h.stringAddress(h.context.getUint32(0x74, true), h.word());
        const second = h.stringAddress(h.context.getUint32(0x74, true), h.word());
        h.state.put(0x7cb038, 0);
        h.state.put(0x7fc93c, 0);
        for (const [address, target, count] of [
          [first, 0x661000, 0x7cb038],
          [second, 0x80c400, 0x7fc93c],
        ]) {
          let cursor = address!,
            length = 0;
          for (;;) {
            const byte = h.scriptByte(cursor);
            if (byte === 255) break;
            if (byte & 128) {
              h.state.put(target! + length * 2, ((byte & 127) << 8) | h.scriptByte(cursor + 1), 2);
              length++;
            }
            cursor += 2;
          }
          h.state.put(count!, length);
        }
      },
    },
  ],
]);
