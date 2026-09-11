import {
  beginTextFrame,
  textContext,
  collectTextFrame,
  textInteractionBoundary,
} from './dom-text-data.js';
import {noahMenuAllowsSidebar} from './menu-presentation.js';
import {drawMenus} from './menu-renderer.js';
import {drawGlobalWaitMarker, drawSceneNotification} from './scene-notification-draw.js';
import {
  drawSelectionWindow,
  drawAuxiliaryWindow,
  drawAuxiliaryGlyphs,
} from './selection-window-draw.js';
import {drawSelectionList} from './selection-list-draw.js';
import {drawDelusion} from './delusion-draw.js';
import {drawChoiceLayer, drawEarlyChoiceLayer} from './choice-draw.js';
import {drawPhone} from './phone-draw.js';
import {
  drawSceneAttachments,
  sceneFilterEffects,
  drawBackgroundAnimation,
} from './scene-effects.js';
import {compileNativeRectangles} from './rectangle-submit.js';
import {drawPanorama} from './panorama-draw.js';
import {nativeBlend} from './render-state.js';
import {movieAtPriority, movieSceneReady} from './movie-draw.js';
import {advanceCharacterAnimation, voiceMouth, drawCharacter} from './character-draw.js';
import {advanceRain} from './rain.js';
import {advanceSnow} from './snow.js';
import {
  sceneParticlesAtPriority,
  advanceSceneRenderState,
  advanceSceneRenderTimers,
  prepareCharacterTrails,
} from './scene-particles.js';
import {drawBackgroundOverlay} from './background-overlay.js';
import {drawSceneText} from './scene-text-draw.js';
import {drawSceneHud} from './scene-hud-draw.js';
import {sceneFills} from './scene-fills.js';
import type {Sc3Runtime} from './runtime.js';
import type {CapturedDialogFrame} from './dialog-canvas.js';
import {drawBackground, drawCapturedBackground} from './background-draw.js';
import {drawDialog} from './dialog-draw.js';
import type {DialogDrawList} from './dialog-draw.js';
import type {TextureImage} from './textures.js';
import {sceneDrawContexts} from './scene-contexts.js';

/** Native 14005f0e0 draw-context traversal and 140011260 scene priorities. */
export function captureStartupFrame(vm: Sc3Runtime, pass: number): CapturedDialogFrame {
  vm.textures.beginFrame();
  try {
    const s = vm.state;
    beginTextFrame(s);
    s.put(0x586a54, s.get(0x587340));
    const draw: DialogDrawList = {sprites: [], regions: [], commands: []};
    let label = 'Black frame',
      menuAllowsSidebar = false;
    const initialImages = new Map(
        [...vm.textures.resources].map(([id, r]) => [id, r.pending ?? r.image]),
      ),
      seenImages = new Map(initialImages);
    // CPU allocation changes are ordered with draw submissions. Earlier rectangles
    // retain the metadata and pixels of the allocation they actually addressed.
    const flush = () => {
      draw.commands = compileNativeRectangles(s, draw.commands!, vm.textures.resources);
    };
    const resourceChanges = () => {
      const changed = [...vm.textures.resources].filter(
        ([id, r]) => seenImages.get(id) !== (r.pending ?? r.image),
      );
      if (!changed.length) return;
      flush();
      for (const [id, r] of changed) {
        const image = r.pending ?? r.image;
        draw.commands!.push({kind: 'texture', texture: id, image});
        seenImages.set(id, image);
      }
    };

    for (const context of sceneDrawContexts(vm)) {
      textContext(s, context.byteOffset);
      const type = context.getInt32(0x84, true);
      if (type === 1 && !(s.flags[0x9e]! & 1) && s.variable(0x33d8 / 4) !== 256) {
        advanceSceneRenderState(s);
        advanceCharacterAnimation(s);
        for (let i = 0; i < 3; i++)
          s.put(
            0x545648 + i * 4,
            voiceMouth(s, s.bytes(0x5b10b5 + i * 0x11984, 1)[0]!, (a) => vm.dataByte(a)),
          );
        advanceSceneRenderTimers(s);
        advanceRain(s);
        advanceSnow(s);
        prepareCharacterTrails(s);
        movieSceneReady(vm);
        const captured = [false, false];
        for (let priority = 0; priority <= 100; priority++) {
          for (let bank = 0; bank < 2; bank++)
            if (s.variable((0x5ac8 + bank * 80) / 4) === priority) {
              const overlays = drawBackgroundOverlay(s, bank);
              draw.sprites.push(...overlays);
              draw.commands!.push(...overlays);
            }
          for (let i = 0; i < 8; i++) {
            if (!s.flag(0x960 + i) || s.flag(0x4f6 + i)) continue;
            // Native has two independent priority tests; equal priorities draw twice.
            for (const address of [0x4670, 0x4698])
              if (s.variable(address / 4 + i * 40) === priority) {
                const sprites = drawBackground(s, i);
                draw.sprites.push(
                  ...sprites.filter(
                    (d): d is import('../../../../../graphics/draw-list.js').SpriteDraw =>
                      !('kind' in d),
                  ),
                );
                draw.commands!.push(...sprites);
                s.put(0x578b88, 255);
                const end = s.variable((address === 0x4670 ? 0x46a0 : 0x46a4) / 4 + i * 40) >>> 0,
                  composition = s.variable(0x3520 / 4 + i) >>> 0;
                if (
                  end !== 0 &&
                  s.variable(address / 4 + i * 40) >>> 0 < end &&
                  [0x558fe8, 0x558ff8, 0x559008].some((a) => s.get(a + composition * 60) !== 0)
                ) {
                  s.put(0x56ca8c, end);
                  s.put(0x578b88, i);
                }
                draw.commands!.push(...drawPhone(vm, i));
                const animation = drawBackgroundAnimation(s, i);
                draw.sprites.push(...animation);
                draw.commands!.push(...animation);
                if (sprites.length) label = `Background ${s.variable(0x466c / 4 + i * 40)}`;
              }
          }
          for (let bank = 0; bank < 2; bank++)
            if (captured[bank] && s.flag(0x97f + bank))
              for (const a of [0x4e40, 0x4e60])
                if (s.variable((a + bank * 80) / 4) === priority) {
                  const layer = drawCapturedBackground(s, bank);
                  draw.commands!.push(...layer);
                  draw.sprites.push(
                    ...layer.filter(
                      (d): d is import('../../../../../graphics/draw-list.js').SpriteDraw =>
                        !('kind' in d),
                    ),
                  );
                }
          if (!(s.flags[0x9b]! & 16) || !(s.variable(0x2104 / 4) & 2))
            for (let i = 0; i < 8; i++) {
              if (!s.flag(0x96a + i) || s.variable(0x13f5 + i * 40) === 65535) continue;
              for (const a of [0x4fd8, 0x5000])
                if (s.variable(a / 4 + i * 40) === priority)
                  draw.commands!.push(...drawCharacter(s, i));
            }
          if (s.get(0x578b88) !== 255 && s.get(0x56ca8c) === priority) s.put(0x578b88, 255);
          draw.commands!.push(...drawSceneAttachments(s, priority));
          for (const a of [0x6c84, 0x6c6c])
            if (s.variable(a / 4) === priority && s.variable(0x6c80 / 4) !== 0)
              draw.commands!.push(...drawPanorama(s));
          draw.commands!.push(
            ...sceneParticlesAtPriority(s, priority),
            ...sceneFilterEffects(s, priority),
          );
          const choiceLayers = [
            ...(s.variable(0x6d54 / 4) === priority ? [drawEarlyChoiceLayer(s)] : []),
            ...(s.variable(0x6d3c / 4) === priority
              ? [drawChoiceLayer(s, 0), drawChoiceLayer(s, 1), drawChoiceLayer(s, 2)]
              : []),
          ];
          for (const layer of choiceLayers) {
            draw.commands!.push(...layer.commands!);
            draw.sprites.push(...layer.sprites);
            draw.regions.push(...layer.regions);
          }
          for (const layer of [
            ...(s.variable(0x6d40 / 4) === priority ? [drawSelectionList(vm)] : []),
            ...(s.variable(0x6c64 / 4) === priority && s.get(0x531fa4) !== 0
              ? [drawDelusion(s)]
              : []),
          ]) {
            draw.commands!.push(...layer.commands!);
            draw.sprites.push(...layer.sprites);
            draw.regions.push(...layer.regions);
          }
          const movies = movieAtPriority(vm, priority);
          resourceChanges();
          draw.sprites.push(
            ...movies.filter(
              (d): d is import('../../../../../graphics/draw-list.js').SpriteDraw => !('kind' in d),
            ),
          );
          draw.commands!.push(...movies);
          draw.commands!.push(...sceneFills(s, priority));
          for (let bank = 0; bank < 2; bank++) {
            const a = 0x629c + bank * 12,
              first = s.variable(a / 4) >>> 0,
              last = s.variable(a / 4 + 1) >>> 0;
            if (
              s.variable(a / 4 + 2) !== 0 &&
              (priority === first || (first < last && priority === last))
            ) {
              draw.commands!.push({
                kind: 'capture',
                texture: 200 + bank,
                width: 1920,
                height: 1080,
              });
              captured[bank] = true;
            }
          }
          if (s.flags[0x137]! & 2 && s.variable(0x6298 / 4) === priority)
            draw.commands!.push({kind: 'capture', texture: 202, width: 1920, height: 1080});
        }
        if (s.flags[0x96]! & 64) {
          draw.commands!.push({kind: 'capture', texture: 208, width: 256, height: 135});
          vm.textures.requestThumbnailReadback();
          s.flags[0x96] = s.flags[0x96]! & ~64;
        }
        if (s.flags[0x136]! & 2) {
          flush();
          vm.textures.createRgba(s.variable(0x3a70 / 4), 1920, 1080);
          resourceChanges();
          s.flags[0x136] = s.flags[0x136]! & ~2;
        }
      }
      if (type === 0 && !(s.flags[0x9b]! & 16)) {
        const commands = drawSceneText(s);
        draw.commands!.push(...commands);
        draw.sprites.push(
          ...commands.filter(
            (d): d is import('../../../../../graphics/draw-list.js').SpriteDraw => !('kind' in d),
          ),
        );
        if (commands.some((d) => !('kind' in d) && d.texture >= 91 && d.texture <= 92))
          label = 'Scene message';
        const opacity = s.variable(0x20f0 / 4);
        if (opacity) {
          const layer = drawSelectionWindow(s, opacity);
          draw.commands!.push(
            ...layer.commands!,
            ...drawAuxiliaryGlyphs(s, 0, 7, opacity),
            ...drawAuxiliaryGlyphs(s, 1, 7, opacity),
          );
          draw.regions.push(...layer.regions);
        }
      }
      if (type === 0)
        draw.commands!.push(...drawGlobalWaitMarker(vm), ...drawSceneNotification(vm));
      if (type === 4) {
        const first = s.variable(0x20f8 / 4),
          second = s.variable(0x20fc / 4);
        if (first) {
          const alpha = (first - (second >>> 1)) | 0;
          draw.commands!.push(
            ...drawAuxiliaryWindow(s, 0, alpha),
            ...drawAuxiliaryGlyphs(s, 0, 5, alpha),
          );
        }
        if (second)
          draw.commands!.push(
            ...drawAuxiliaryWindow(s, 1, second),
            ...drawAuxiliaryGlyphs(s, 0, 6, second),
          );
      }
      if (type === 6) {
        const sprites = drawSceneHud(s);
        draw.sprites.push(...sprites);
        draw.commands!.push(...sprites);
      }
      if (type === 3)
        draw.commands!.push({
          kind: 'solid',
          destination: {x: 0, y: 0, width: 2880, height: 1620},
          color: context.getUint32(0xbc, true) & 0xffffff,
          alpha: Math.max(0, Math.min(255, s.variable(0x33d8 / 4))),
        });
      if (type === 10) {
        menuAllowsSidebar ||= noahMenuAllowsSidebar(s);
        const layer = drawMenus(vm);
        if (noahMenuAllowsSidebar(s)) textInteractionBoundary(layer.commands!);
        resourceChanges();
        draw.sprites.push(...layer.sprites);
        draw.commands!.push(...layer.commands!);
        draw.regions.push(...layer.regions);
        if (layer.commands!.length) label = 'Menu';
      }
      if (type !== 11 && type !== 23) continue;
      const channel = type === 11 ? 0 : 1,
        fade = s.variable(0xcfe + channel);
      if (!fade) continue;
      if (channel === 1)
        draw.commands!.push({
          kind: 'solid',
          destination: {x: 0, y: 0, width: 1920, height: 1080},
          color: 0,
          alpha: Math.max(0, Math.min(255, Math.imul(fade, 3) >>> 2)),
        });
      const layer = drawDialog(vm.messageBoxes, channel, fade);
      textInteractionBoundary(layer.sprites);
      draw.sprites.push(...layer.sprites);
      draw.commands!.push(...layer.sprites);
      draw.regions.push(...layer.regions);
      label = `Message ${vm.messageBoxes.snapshots.length}`;
    }
    // 14001e4c0 consumes one rand() after the complete 14005f0e0 draw traversal.
    s.random15();
    for (const command of draw.commands!)
      if (!(
        'kind' in command &&
        (command.kind === 'capture' || command.kind === 'target' || command.kind === 'texture')
      ))
        command.blendState ??= nativeBlend(!('kind' in command) && command.blend === 'add' ? 2 : 0);
    const revealed = label.startsWith('Background')
      ? !draw.commands!.some((d) => 'kind' in d && d.kind === 'solid' && d.alpha > 0)
      : s.variable(0xcfe) >= 32 || s.variable(0xcff) >= 32;
    draw.commands = compileNativeRectangles(s, draw.commands!, vm.textures.resources);
    for (const d of draw.commands) if ('kind' in d && d.kind === 'triangles') d.depthClip = false;
    const textures = new Map<number, TextureImage>();
    textures.set(-1, {width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255])});
    for (const id of draw.commands!.flatMap((d) =>
      'kind' in d
        ? d.kind === 'triangles'
          ? [
              d.texture,
              ...(d.mask ? [d.mask.texture] : []),
              ...(d.additionalTextures ?? []).map((t) => t.texture),
            ]
          : d.kind === 'capture' || (d.kind === 'target' && d.texture !== null)
            ? [d.texture!]
            : []
        : d.mask
          ? [d.texture, d.mask.texture]
          : [d.texture],
    )) {
      if (textures.has(id)) continue;
      const resource = vm.textures.resources.get(id);
      if (!resource) throw new Error(`Missing startup texture ${id}`);
      // Pending images are immutable; transfers replace them, including reused slots.
      textures.set(id, initialImages.get(id) ?? resource.pending ?? resource.image);
    }
    return {
      pass,
      label,
      menuAllowsSidebar,
      text: collectTextFrame(draw.commands!, s, initialImages),
      message: vm.messageBoxes.snapshots.length,
      revealed,
      draw,
      textures,
    };
  } finally {
    vm.textures.endFrame();
  }
}
