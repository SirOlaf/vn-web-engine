import {createHash} from 'node:crypto';
import {open, readFile} from 'node:fs/promises';
import {Xp3Archive} from '../dist/formats/kirikiri/xp3.js';
import {CX_TINY_FILTERS, CxArchive} from '../dist/formats/kirikiri/cx-archive.js';
import {PsbFile} from '../dist/formats/kirikiri/psb.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {emoteTextureLevelLength, readEmoteTexture} from '../dist/formats/kirikiri/emote-texture.js';
import {decodeEmoteIcon} from '../dist/formats/kirikiri/psb-rl.js';
import {DXT5_EMOTEDRIVER, DXT5_FOUR_COLOR, Dxt5Decoder} from '../dist/graphics/s3tc.js';

/**
 * Non-visual E-mote texture check. Decodes every `DXT5` source texture level with the Wasm
 * decoder and an independent reference decoder (below) in both color modes and compares
 * SHA-256; checks level byte lengths; decodes every `RL` icon and checks that the stream is
 * consumed exactly into `width * height` texels. Prints counts, sizes and hashes only.
 * Decoded pixels stay in memory and are never written or displayed.
 *
 *   npm run build:runtime
 *   node tools/probe-kirikiri-emote-textures.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>...
 */
class FileSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }
  async read(offset, length) {
    const bytes = new Uint8Array(length);
    const {bytesRead} = await this.handle.read(bytes, 0, length, offset);
    if (bytesRead !== length) throw new Error('Short read');
    return bytes;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Reference BC3 decoder: per block, then per texel from the spec formulas. */
function referenceDxt5(blocks, width, height, threeColorWhenNotGreater) {
  const out = new Uint8Array(width * height * 4),
    blocksX = Math.ceil(width / 4),
    blocksY = Math.ceil(height / 4),
    palette = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    alpha = [0, 0, 0, 0, 0, 0, 0, 0],
    stats = {lowEndpointBlocks: 0, lowEndpointIndex3Texels: 0};
  const widen = (raw, target) => {
    const r = Math.floor(raw / 2048),
      g = Math.floor(raw / 32) % 64,
      b = raw % 32;
    target[0] = r * 8 + Math.floor(r / 4);
    target[1] = g * 4 + Math.floor(g / 16);
    target[2] = b * 8 + Math.floor(b / 4);
  };
  for (let by = 0; by < blocksY; by++)
    for (let bx = 0; bx < blocksX; bx++) {
      const o = (by * blocksX + bx) * 16,
        a0 = blocks[o],
        a1 = blocks[o + 1];
      alpha[0] = a0;
      alpha[1] = a1;
      for (let k = 2; k < 8; k++)
        alpha[k] =
          a0 > a1
            ? Math.floor(((8 - k) * a0 + (k - 1) * a1) / 7)
            : k === 6
              ? 0
              : k === 7
                ? 255
                : Math.floor(((6 - k) * a0 + (k - 1) * a1) / 5);
      const raw0 = blocks[o + 8] + blocks[o + 9] * 256,
        raw1 = blocks[o + 10] + blocks[o + 11] * 256;
      widen(raw0, palette[0]);
      widen(raw1, palette[1]);
      const low = raw0 <= raw1;
      if (low) stats.lowEndpointBlocks++;
      for (let c = 0; c < 3; c++) {
        const p = palette[0][c],
          q = palette[1][c];
        if (low && threeColorWhenNotGreater)
          palette[2][c] = palette[3][c] = Math.floor((p + q) / 2);
        else {
          palette[2][c] = Math.floor((2 * p + q) / 3);
          palette[3][c] = Math.floor((p + 2 * q) / 3);
        }
      }
      for (let t = 0; t < 16; t++) {
        const x = bx * 4 + (t % 4),
          y = by * 4 + Math.floor(t / 4);
        const bit = 3 * t,
          byte = o + 2 + Math.floor(bit / 8),
          word = blocks[byte] + (byte + 1 < o + 8 ? blocks[byte + 1] * 256 : 0),
          ai = Math.floor(word / 2 ** (bit % 8)) % 8,
          ci = Math.floor(blocks[o + 12 + Math.floor(t / 4)] / 4 ** (t % 4)) % 4;
        if (low && ci === 3) stats.lowEndpointIndex3Texels++;
        if (x >= width || y >= height) continue;
        const target = (y * width + x) * 4;
        out[target] = palette[ci][0];
        out[target + 1] = palette[ci][1];
        out[target + 2] = palette[ci][2];
        out[target + 3] = alpha[ai];
      }
    }
  return {out, stats};
}

const [plugin, runtime, ...archives] = process.argv.slice(2);
if (!plugin || !runtime || !archives.length) {
  console.error(
    'usage: probe-kirikiri-emote-textures.mjs <plugin.tpm> <emotedriver.dll> <archive.xp3>...',
  );
  process.exit(2);
}
const filter = CX_TINY_FILTERS.get(sha256(await readFile(plugin)));
if (!filter) throw new Error('No tiny filter known for the storage plugin');
const key = EMOTE_PSB_KEYS.get(sha256(await readFile(runtime)));
if (key === undefined) throw new Error('No E-mote key known for the runtime');

const decoder = new Dxt5Decoder();
if (!decoder.accelerated) throw new Error('Wasm DXT5 decoder did not instantiate');
const totals = {
  files: 0,
  dxt5Textures: 0,
  dxt5Levels: 0,
  dxt5Bytes: 0,
  dxt5Agree: 0,
  dxt5Disagree: 0,
  lowEndpointBlocks: 0,
  lowEndpointIndex3Texels: 0,
  modeDifferentLevels: 0,
  rgba8Textures: 0,
  rgba8Levels: 0,
  levelLengthMismatches: 0,
  truncatedDiffers: 0,
  rlIcons: 0,
  rlInputBytes: 0,
  rlOutputBytes: 0,
  rlFailures: 0,
  otherIcons: 0,
};

for (const path of archives) {
  const handle = await open(path),
    {size} = await handle.stat();
  try {
    const cx = new CxArchive(await Xp3Archive.open(new FileSource(handle, size)), filter);
    for (const record of cx.names) {
      if (!/\.psb$/i.test(record.name)) continue;
      const entry = cx.find(record.name);
      if (!entry) continue;
      const root = new PsbFile(decryptPsbBody(await cx.readEntry(entry), key)).root;
      totals.files++;
      const line = {file: record.name, spec: root.spec, textures: [], icons: null};
      const iconHash = createHash('sha256');
      let icons = 0,
        iconIn = 0,
        iconOut = 0;
      for (const [sourceName, source] of Object.entries(root.source ?? {})) {
        if (source?.texture) {
          const texture = readEmoteTexture(source.texture);
          if (
            texture.truncatedWidth !== texture.width ||
            texture.truncatedHeight !== texture.height
          )
            totals.truncatedDiffers++;
          for (const level of texture.levels)
            if (
              level.pixels.length !==
              emoteTextureLevelLength(texture.type, level.width, level.height)
            )
              totals.levelLengthMismatches++;
          const summary = {
            source: sourceName,
            type: texture.type,
            size: `${texture.width}x${texture.height}`,
            levels: texture.levels.map((level) => `${level.width}x${level.height}`).join(','),
            mipMapLevel: texture.mipMapLevel,
          };
          if (texture.type === 'DXT5') {
            totals.dxt5Textures++;
            const hashes = {four: createHash('sha256'), emotedriver: createHash('sha256')};
            let agree = true;
            for (const level of texture.levels) {
              totals.dxt5Levels++;
              totals.dxt5Bytes += level.pixels.length;
              const results = {};
              for (const [name, mode] of [
                ['four', DXT5_FOUR_COLOR],
                ['emotedriver', DXT5_EMOTEDRIVER],
              ]) {
                const wasm = sha256(decoder.decode(level.pixels, level.width, level.height, mode));
                const reference = referenceDxt5(
                  level.pixels,
                  level.width,
                  level.height,
                  mode === DXT5_EMOTEDRIVER,
                );
                if (mode === DXT5_FOUR_COLOR) {
                  totals.lowEndpointBlocks += reference.stats.lowEndpointBlocks;
                  totals.lowEndpointIndex3Texels += reference.stats.lowEndpointIndex3Texels;
                }
                if (wasm !== sha256(reference.out)) agree = false;
                hashes[name].update(wasm);
                results[name] = wasm;
              }
              if (results.four !== results.emotedriver) totals.modeDifferentLevels++;
            }
            if (agree) totals.dxt5Agree++;
            else totals.dxt5Disagree++;
            summary.agree = agree;
            summary.sha256FourColor = hashes.four.digest('hex');
            summary.sha256Emotedriver = hashes.emotedriver.digest('hex');
          } else if (texture.type === 'RGBA8') {
            totals.rgba8Textures++;
            totals.rgba8Levels += texture.levels.length;
          }
          line.textures.push(summary);
        }
        for (const icon of Object.values(source?.icon ?? {})) {
          if (icon?.compress !== 'RL') {
            if (icon?.pixel) totals.otherIcons++;
            continue;
          }
          try {
            const decoded = decodeEmoteIcon(icon);
            if (decoded.bgra.length !== decoded.width * decoded.height * 4)
              throw new Error('output length');
            icons++;
            iconIn += icon.pixel.bytes.length;
            iconOut += decoded.bgra.length;
            iconHash.update(decoded.bgra);
          } catch (error) {
            totals.rlFailures++;
            console.error(`${record.name} ${sourceName}: ${error.message}`);
          }
        }
      }
      if (icons) {
        totals.rlIcons += icons;
        totals.rlInputBytes += iconIn;
        totals.rlOutputBytes += iconOut;
        line.icons = {
          rl: icons,
          inputBytes: iconIn,
          outputBytes: iconOut,
          sha256: iconHash.digest('hex'),
        };
      }
      console.log(JSON.stringify(line));
    }
  } finally {
    await handle.close();
  }
}
console.log(JSON.stringify({totals}));
