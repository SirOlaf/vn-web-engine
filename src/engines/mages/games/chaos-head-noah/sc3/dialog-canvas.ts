import type {Sc3Runtime} from './runtime.js';
import type {TextureImage} from './textures.js';
import {drawDialog} from './dialog-draw.js';
import type {DialogDrawList} from './dialog-draw.js';

export interface CapturedDialogFrame {
  text?: ReturnType<typeof import('./dom-text-data.js').collectTextFrame>;
  pass: number;
  label?: string;
  menuAllowsSidebar?: boolean;
  message: number;
  revealed: boolean;
  draw: DialogDrawList;
  textures: ReadonlyMap<number, TextureImage>;
}
/** Record audited dialog layers. This is not the as-yet incomplete full engine frame dispatcher. */
export function captureDialogs(vm: Sc3Runtime, pass: number): CapturedDialogFrame | undefined {
  const draw: DialogDrawList = {sprites: [], regions: []};
  for (let channel = 0; channel < 2; channel++) {
    const fade = vm.state.variable(0xcfe + channel);
    if (!fade) continue;
    const layer = drawDialog(vm.messageBoxes, channel, fade);
    draw.sprites.push(...layer.sprites);
    draw.regions.push(...layer.regions);
  }
  if (!draw.sprites.length) return undefined;
  const textures = new Map<number, TextureImage>();
  for (const {texture: id} of draw.sprites) {
    if (textures.has(id)) continue;
    const resource = vm.textures.resources.get(id);
    if (!resource) throw new Error(`Missing dialog texture ${id}`);
    textures.set(
      id,
      resource.pending ?? {...resource.image, pixels: resource.image.pixels.slice()},
    );
  }
  return {
    pass,
    message: vm.messageBoxes.snapshots.length,
    revealed: vm.state.variable(0xcfe) >= 32 || vm.state.variable(0xcff) >= 32,
    draw,
    textures,
  };
}
