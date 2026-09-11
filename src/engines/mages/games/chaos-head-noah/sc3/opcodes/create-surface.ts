import type {OpcodeExecution} from './types.js';

/** Entire 01/00, 14004aa10. Selector zero creates R8; other bytes create RGBA. */
export function createSurface(h: OpcodeExecution): void {
  if (h.state.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  const selector = h.byte(),
    id = h.expression(),
    width = h.expression(),
    height = h.expression();
  h.backgroundTextures.textures.createSurface(id, width, height, selector === 0 ? 0xa0 : 0);
}
