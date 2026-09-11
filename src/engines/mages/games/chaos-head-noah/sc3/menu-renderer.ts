import {textInteractionBoundary} from './dom-text-data.js';
import type {Sc3Runtime} from './runtime.js';
import type {DialogDrawList} from './dialog-draw.js';
import {drawTitleParent} from './title-parent-draw.js';
import {drawGameMenu, drawEndingMenu, appendMenuMarker} from './game-menu-draw.js';
import {drawMenuNavigation} from './menu-navigation-draw.js';
import {drawSaveMenu} from './save-menu-draw.js';
import {drawBacklog} from './backlog-draw.js';
import {drawTips} from './tips-draw.js';
import {drawConfig} from './config-draw.js';
import {drawGallery} from './gallery-draw.js';
import {drawMovieGallery} from './movie-gallery-draw.js';
import {drawMusicRoom} from './music-room-draw.js';
import {drawHelp} from './help-draw.js';
import {nativeBlend, nativeSampler} from './render-state.js';
/** 14002e710 followed by 140028eb0, as called by draw context 10. */
export function drawMenus(vm: Sc3Runtime): DialogDrawList {
  const s = vm.state,
    out: DialogDrawList = {sprites: [], commands: [], regions: []},
    v = (a: number) => s.variable(a / 4),
    title = !!(s.flags[0x9b]! & 1),
    overlay = v(0x2190),
    opacity = v(0x2194),
    fade = v(0x218c),
    extra = v(0x219c),
    progress = v(0x2178),
    force = !!(s.flags[0x99]! & 16);
  const push = (p: DialogDrawList) => {
    textInteractionBoundary(p.commands ?? p.sprites);
    out.sprites.push(...p.sprites);
    out.commands!.push(...(p.commands ?? p.sprites));
    out.regions.push(...p.regions);
  };
  const sprites = (ds: DialogDrawList['sprites']) => {
    out.sprites.push(...ds);
    out.commands!.push(...ds);
  };
  const full = (texture: number, sx: number, alpha: number) =>
    sprites([
      {
        texture,
        source: {x: sx, y: 0, width: 1920, height: 1080},
        destination: {x: 0, y: 0, width: 1920, height: 1080},
        color: 0xffffff,
        alpha: Math.max(0, Math.min(255, alpha | 0)),
        ...nativeSampler(s),
        blendState: nativeBlend(s.view(0x587344, 2).getUint16(0, true)),
      },
    ]);
  let enabled = v(0x217c) !== 0 || progress !== 0 || title || force;
  if (enabled) {
    if (title) {
      push(drawTitleParent(s));
      enabled =
        (fade !== 0 && (v(0x210c) === 5 || v(0x210c) === 15)) || extra !== 0 || overlay === 12;
    } else if (progress !== 0) push(drawGameMenu(s));
  }
  if (enabled && ((progress === 32 && fade !== 0) || extra !== 0 || overlay === 12 || force)) {
    const start = out.commands!.length;
    switch (overlay) {
      case 0:
      case 3:
      case 4:
        push(drawSaveMenu(vm, overlay));
        break;
      case 1:
        push(drawBacklog(s));
        break;
      case 2:
        push(drawTips(vm));
        break;
      case 5:
        push(drawConfig(s));
        break;
      case 7:
        full(163, 0, opacity);
        full(163, 2176, opacity);
        break;
      case 8:
        push(drawGallery(s));
        break;
      case 9:
        push(drawMovieGallery(vm));
        break;
      case 10:
        push(drawMusicRoom(vm));
        break;
      case 11:
        full(164, 0, Math.imul(opacity, fade) >>> 5);
        appendMenuMarker(s, 0);
        break;
      case 12:
        sprites(drawHelp(s, opacity));
        break;
      case 14:
        push(drawEndingMenu(s));
        break;
      // Native cases 6/13 and the default have no drawing side effects.
    }
    textInteractionBoundary(out.commands!.slice(start));
  }
  sprites(drawMenuNavigation(vm));
  return out;
}
