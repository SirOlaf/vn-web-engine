import type {Sc3Runtime} from './runtime.js';
import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {navigationItems, navigationBindings, navigationGlyphs} from './menu-navigation-data.js';
import {configPadIcons} from './config-data.js';
import {drawMenuText} from './menu-text-draw.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 140028eb0. Its removal loop intentionally advances past the shifted entry. */
export function advanceMenuNavigation(s: NoahState): void {
  const ids: number[] = [],
    fades: number[] = [],
    current = s.get(0x5b04b8) >>> 0,
    old = s.get(0x5afaa0) >>> 0;
  if (current === 0) {
    ids.push(255);
    fades.push(16);
  } else {
    for (let i = (current - 1) | 0; i >= 0; i--) {
      const id = s.get(0x5b09b8 + i * 4);
      let fade = 0;
      for (let j = 0; j < old; j++)
        if (s.get(0x5afa30 + j * 8) === id) {
          s.put(0x5afa30 + j * 8, 255);
          fade = s.get(0x5afa34 + j * 8) >>> 0;
          break;
        }
      ids.push(id);
      fades.push(fade);
    }
    if (fades[0]! < 256) fades[0] = (fades[0]! + 16) >>> 0;
  }
  const count = ids.length;
  for (let i = 1; i < count; i++) {
    if (fades[i] !== 0) fades[i] = (fades[i]! - 16) >>> 0;
    if (fades[i] === 0 || ids[i] === 255) {
      for (let j = i; j < count - 1; j++) {
        ids[j] = ids[j + 1]!;
        fades[j] = fades[j + 1]!;
      }
      fades[count - 1] = 0;
    }
  }
  let retained = 1;
  while (retained < count && fades[retained] !== 0) retained++;
  if (retained === 1 && ids[0] === 255) retained = 0;
  s.put(0x5afaa0, retained);
  for (let i = 0; i < retained; i++) {
    s.put(0x5afa30 + i * 8, ids[i]!);
    s.put(0x5afa34 + i * 8, fades[i]!);
  }
}
/** 140028b90: atlas icons and MES text, using the serialized native pad bindings. */
export function drawNavigationStrip(vm: Sc3Runtime, id: number, alpha: number): SpriteDraw[] {
  const s = vm.state,
    out: SpriteDraw[] = [];
  if (id === 255 || s.flags[0xe5]! & 1) return out;
  const sprite = (sx: number, sy: number, width: number, height: number, x: number, y: number) =>
    out.push({
      texture: 148,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    });
  sprite(0, (id - 4) >>> 0 < 2 ? 206 : 0, 1920, (id - 4) >>> 0 < 2 ? 94 : 74, 0, 1018);
  const mode = s.get(0x20d22c) >>> 0,
    items = navigationItems[mode * 13 + (id >>> 0)];
  if (!items) throw new Error(`Native navigation table outside mapped data: ${mode}/${id}`);
  let x = 64,
    wasText = false;
  for (const item of items) {
    if (item < 10000) {
      if (wasText) x = (x + 30) | 0;
      let icon = item;
      if (mode === 0) {
        const binding = navigationBindings.find((p) => p[0] === item)?.[1];
        if (binding !== undefined && binding !== -1) {
          const button = (vm.storage.configuration[0x74 + binding]! << 24) >> 24;
          if (button === -1) {
            wasText = false;
            continue;
          }
          const mapped = configPadIcons[button];
          if (mapped === undefined)
            throw new Error(`Native controller icon outside mapped data: ${button}`);
          icon = mapped;
        }
      }
      const glyph = navigationGlyphs.slice(icon * 4, icon * 4 + 4);
      if (glyph.length !== 4)
        throw new Error(`Native navigation glyph outside mapped atlas: ${icon}`);
      sprite(glyph[0]!, glyph[1]! + 288, glyph[2]!, glyph[3]!, Math.fround(x), 1039);
      x = (x + glyph[2]!) | 0;
      wasText = false;
    } else {
      if (!wasText) x = (x + 10) | 0;
      const address = vm.messageAddress(1, item),
        width = vm.messageBoxes.measure(address, 22, 0);
      out.push(
        ...drawMenuText(
          s,
          {byte: (a) => vm.dataByte(a), expression: (a) => vm.textExpression(a)},
          address,
          Math.trunc(Math.imul(x, 2) / 3),
          692,
          992,
          0xffffff,
          22,
          Math.max(0, Math.min(255, alpha | 0)),
        ),
      );
      x = (x + (Math.imul(width, 3) >>> 1)) | 0;
      wasText = true;
    }
  }
  return out;
}
export function drawMenuNavigation(vm: Sc3Runtime): SpriteDraw[] {
  advanceMenuNavigation(vm.state);
  const out: SpriteDraw[] = [];
  for (let i = vm.state.get(0x5afaa0) - 1; i >= 0; i--)
    out.push(
      ...drawNavigationStrip(vm, vm.state.get(0x5afa30 + i * 8), vm.state.get(0x5afa34 + i * 8)),
    );
  return out;
}
