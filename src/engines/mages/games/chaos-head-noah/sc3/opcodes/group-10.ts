import {manual} from './manual.js';
import {saveMenu} from './save-menu.js';
import {swapCharacter, setSceneMode, gatedExpressions} from './state-commands.js';
import {loadCharacter} from './character.js';
import {loadCheckpoint} from './restore-checkpoint.js';
import {configMenu} from './config.js';
import {unlockTip} from './unlock-tip.js';
import {checkRange} from '../../../../../../core/binary.js';
import {gameEffects} from './game-effects.js';
import {titleMenu} from './title-menu.js';
import {loadBackground} from './background.js';
import {swapBackground} from './swap-background.js';
import {checkpoint} from './checkpoint.js';
import type {OpcodeGroup} from './types.js';
import {resetPersistentState} from './persistent-state.js';
import {suppressConfirmCancelInput} from './input-suppression.js';
import {setBackgroundComposition} from './background-composition.js';
import {setCompositionDescriptor} from './composition-descriptor.js';
import {releaseBackground} from './release-background.js';
import {releaseCharacter} from './release-character.js';
import {sceneWave} from './scene-wave.js';
import {musicRoom} from './music-room.js';
import {cgGallery} from './cg-gallery.js';
import {movieGallery} from './movie-gallery.js';
import {routeMenu} from './route-menu.js';
export const group10: OpcodeGroup = new Map([
  [0x1a, {name: 'manual', native: '14005a7c0', execute: manual}],
  [0x23, {name: 'save/load menu', native: '14005af40', execute: saveMenu}],
  [0x1d, {name: 'music room', native: '14005a960', execute: musicRoom}],
  [0x1f, {name: 'CG gallery', native: '14005a990', execute: cgGallery}],
  [0x20, {name: 'movie gallery', native: '14005aa40', execute: movieGallery}],
  [0x25, {name: 'route menu', native: '14005b050', execute: routeMenu}],
  [0x06, {name: 'swap character records', native: '140059880', execute: swapCharacter}],
  [
    0x1b,
    {
      name: 'native ignored byte command',
      native: '140054600',
      execute(h) {
        h.skip(3);
      },
    },
  ],
  [0x28, {name: 'set scene mode', native: '14005b270', execute: setSceneMode}],
  [
    0x3c,
    {name: 'native gated expressions command', native: '14005d6f0', execute: gatedExpressions},
  ],
  [0x24, {name: 'restore scene checkpoint', native: '14005af90', execute: loadCheckpoint}],
  [
    0x0b,
    {
      name: 'native no-op',
      native: '140054520',
      execute(h) {
        h.skip(2);
      },
    },
  ],
  [
    0x2d,
    {
      name: 'native no-op',
      native: '140054520',
      execute(h) {
        h.skip(2);
      },
    },
  ],
  [0x05, {name: 'load character', native: '140059450', execute: loadCharacter}],
  [0x27, {name: 'unlock TIPS entry', native: '14005b0c0', execute: unlockTip}],
  [
    0x3d,
    {
      name: 'native gated expression command',
      native: '14005d760',
      execute(h) {
        if (h.state.get(0x81007c) !== 0) {
          h.yield();
          return;
        }
        h.skip(2);
        h.expression();
      },
    },
  ],
  [
    0x29,
    {
      name: 'unlock gallery entry',
      native: '14005b2c0',
      execute(h) {
        h.skip(3);
        const index = h.expression();
        checkRange(h.state.galleryUnlocks.length, index, 1);
        h.state.galleryUnlocks[index] = 1;
      },
    },
  ],
  [0x22, {name: 'scene checkpoint', native: '14005aae0', execute: checkpoint}],
  [0x02, {name: 'swap background records', native: '140059100', execute: swapBackground}],
  [0x13, {name: 'configuration menu', native: '14005a050', execute: configMenu}],
  [0x37, {name: 'game effects', native: '14005bd10', execute: gameEffects}],
  [0x34, {name: 'title menu', native: '14005bbe0', execute: titleMenu}],
  [0x01, {name: 'load background', native: '140058c50', execute: loadBackground}],
  [
    0x04,
    {name: 'set background composition', native: '140059380', execute: setBackgroundComposition},
  ],
  [
    0x2a,
    {name: 'set composition descriptor', native: '14005b310', execute: setCompositionDescriptor},
  ],
  [0x10, {name: 'release background', native: '140059ed0', execute: releaseBackground}],
  [0x11, {name: 'release character', native: '140059f90', execute: releaseCharacter}],
  [0x14, {name: 'reset persistent state', native: '14005a5d0', execute: resetPersistentState}],
  [
    0x21,
    {
      name: 'suppress confirm/cancel input',
      native: '14005aa70',
      execute: suppressConfirmCancelInput,
    },
  ],
  [0x30, {name: 'scene wave parameters', native: '14005b4b0', execute: sceneWave}],
  [
    0x3f,
    {
      name: 'native ignored byte command',
      native: '140054600',
      execute(h) {
        h.skip(3);
      },
    },
  ],
  [
    0x33,
    {
      name: 'TIPS',
      native: '14005b9d0',
      execute(h) {
        h.skip(2);
        const mode = h.byte();
        if (mode === 0) {
          const slot = h.context.getUint32(0x74, true);
          const label = () => {
            const pc = Number(h.context.getBigUint64(0x158, true));
            const address = h.labelAddress(slot, h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8));
            h.skip(2);
            return address;
          };
          const entries = label(),
            header = label();
          h.tips.initialize(slot, entries, header, h.language);
        } else if (mode === 1) h.tips.prepare();
        else if (mode === 2) h.tips.interact();
        else if (mode === 4) h.tips.synchronize();
        // Selector 3 and all other byte values have no native effect beyond consumption.
      },
    },
  ],
  [
    0x32,
    {
      name: 'load script event table',
      native: '14005b920',
      execute(h) {
        h.skip(2);
        if (h.byte() !== 0) return;
        const slot = h.context.getUint32(0x74, true);
        const pc = Number(h.context.getBigUint64(0x158, true));
        let address = h.labelAddress(slot, h.scriptByte(pc) | (h.scriptByte(pc + 1) << 8));
        h.skip(2);
        // 1400471b0: three 300-dword arrays, each initialized to 0x0000ffff.
        const tables = [0x6e7eb0, 0x69e620, 0x799da0];
        for (const table of tables) for (let i = 0; i < 300; i++) h.state.put(table + i * 4, 65535);
        h.state.put(0x66d8d8, slot);
        h.state.put(0x76871c, 0);
        const read = (n: number) => {
          let value = 0;
          for (let i = 0; i < n; i++) value += h.scriptByte(address++) * 2 ** (i * 8);
          return value;
        };
        for (let index = 0, key = read(2); key !== 65535; index++, key = read(2)) {
          h.state.put(0x76871c, index + 1);
          h.state.put(tables[0]! + index * 4, key);
          h.state.put(tables[1]! + index * 4, read(4));
          h.state.put(tables[2]! + index * 4, read(4));
        }
      },
    },
  ],
  [
    0x00,
    {
      name: 'reset',
      native: '140057080',
      execute(h) {
        h.skip(2);
        h.state.reset(h.expression(), h.configEnabled);
      },
    },
  ],
]);
