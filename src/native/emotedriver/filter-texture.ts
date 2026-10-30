import {readEmoteModel} from '../../formats/kirikiri/emote-model.js';
import {PsbFile} from '../../formats/kirikiri/psb.js';
import {applyPsbKeystream} from '../../formats/kirikiri/psb-filter.js';
import {ByteView} from '../../core/binary.js';

/**
 * `EmoteFilterTexture` (0x10002c20). The PSB image is decrypted in place (`StructCryptFilter`
 * over the header range [u32@0x08, u32@0x18)), then `filter` receives the pixel bytes of every
 * `source` atlas whose `type` is exactly `RGBA8`, followed by those of each `mipMap` level, in
 * source order. Pixels are views of `data`, so the filter's writes land in `data`. The image
 * stays decrypted on return, as natively. A source without `texture` aborts natively; it
 * throws here.
 */
export function emoteFilterTexture(
  data: Uint8Array,
  key: number,
  filter: (pixels: Uint8Array) => void,
): void {
  const view = new ByteView(data, {littleEndian: true});
  if (view.ascii(0, 4) !== 'PSB\0') throw new Error('Not a PSB file');
  const start = view.u32(8),
    end = view.u32(24);
  view.check(start, end - start);
  applyPsbKeystream(key, data.subarray(start, end));
  const model = readEmoteModel(new PsbFile(data));
  for (const [name, source] of model.sources) {
    const texture = source.texture;
    if (texture === null) throw new Error(`psb: undefined object key 'texture' (source ${name})`);
    if (texture.type !== 'RGBA8') continue;
    filter(texture.pixel.bytes);
    for (const level of texture.mipMap) filter(level.pixel.bytes);
  }
}
