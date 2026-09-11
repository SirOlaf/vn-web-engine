import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {f, sub, mul, add, trunc} from './render-math.js';
import {configPadBindings, configPadIcons} from './config-data.js';
import {navigationGlyphs} from './menu-navigation-data.js';
import {appendMenuMarker} from './game-menu-draw.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 14003e380: help page transition and live controller-assignment icons. */
export function drawHelp(s: NoahState, opacity: number): SpriteDraw[] {
  const out: SpriteDraw[] = [],
    combined = Math.imul(opacity, s.variable(0x218c / 4)) >>> 5;
  if (!combined) return out;
  const progress = s.get(0x5a9ab8),
    shift = f(Math.imul(s.get(0x5a9ac4), progress)),
    alpha = trunc(mul(mul(f((16 - progress) | 0), 0.0625), f(combined)));
  const emit = (
    texture: number,
    sx: number,
    sy: number,
    width: number,
    height: number,
    x: number,
    y: number,
    a = alpha,
  ) =>
    out.push({
      texture,
      source: {x: sx, y: sy, width, height},
      destination: {x, y, width, height},
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, a | 0)),
      ...nativeSampler(s),
      blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
    });
  if (progress) emit((s.get(0x5af940) + 164) | 0, 0, 0, 1920, 1080, 0, 0, 256);
  emit((s.get(0x5afaa4) + 164) | 0, 0, 0, 1920, 1080, sub(0, shift), 0);
  const glyph = (id: number, row: number, alignment: 'center' | 'left' | 'right') => {
    const g = navigationGlyphs.slice(id * 4, id * 4 + 4);
    if (g.length !== 4) throw new Error(`Native help icon outside mapped atlas: ${id}`);
    const dx =
      alignment === 'center'
        ? sub(1282, g[2]! >>> 1)
        : alignment === 'right'
          ? sub(1282, g[2]!)
          : 1282;
    emit(
      148,
      g[0]!,
      add(g[1]!, 288),
      g[2]!,
      g[3]!,
      sub(dx, shift),
      add(f(Math.imul(row, 68)), 220),
    );
  };
  const button = (row: number) => s.view(configPadBindings[row]!, 2).getInt16(0, true),
    mapped = (key: number) => {
      const icon = configPadIcons[key];
      if (icon === undefined)
        throw new Error(`Native help controller assignment outside mapped data: ${key}`);
      return icon;
    };
  if (s.get(0x5afa98) === 1)
    for (let row = 0; row < 10; row++) {
      if (row === 0) {
        glyph(44, 0, 'center');
        continue;
      }
      const at = row < 7 ? row - 1 : row,
        key = button(at);
      if (row === 6) {
        if (key !== -1) glyph(mapped(key), row, 'right');
        const other = button(at + 1);
        if (other !== -1) glyph(mapped(other), row, 'left');
      } else if (key !== -1) glyph(mapped(key), row, 'center');
    }
  appendMenuMarker(s, 12);
  return out;
}
