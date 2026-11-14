import {png} from './png-fixtures.mjs';
/** Synthetic cache with deliberately non-font-shaped color cells. No game data. */
export function fontCacheFixture({
  color = 0xff0000,
  size = 32,
  codePoint = 65,
  clip = [1, 0, 2, 1],
  layout = 'expanded',
  metrics = [-2, 5, 23],
  style = 0,
  packedKey = ((32 << 24) | ((size & 255) << 16) | (codePoint & 65535)) >>> 0,
} = {}) {
  const face = Buffer.from('synthetic.ttf');
  const fields =
    layout === 'packed'
      ? [color, 0, 0x0000ff, packedKey, 0]
      : layout === 'expanded-metrics'
        ? [size, 0, 1, color, 0, 0x0000ff, style, codePoint, 0]
        : [size, 0, 1, color, 0, 0x0000ff, codePoint, 0];
  const bytes = Buffer.alloc(
    8 + face.length + fields.length * 4 + 16 + (layout === 'expanded-metrics' ? 12 : 0) + 3,
  );
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(face.length, 4);
  bytes.set(face, 8);
  let offset = 8 + face.length;
  for (const value of fields) {
    bytes.writeUInt32LE(value, offset);
    offset += 4;
  }
  for (const value of layout === 'expanded-metrics' ? [...metrics, ...clip] : clip) {
    bytes.writeFloatLE(value, offset);
    offset += 4;
  }
  // The native stream ignores bytes after its declared records.
  bytes.set([11, 22, 33], offset);
  return {
    'cache/index.dat': bytes,
    'cache/0.png': png({
      width: 3,
      height: 2,
      raw: Buffer.from([
        0, 7, 8, 9, 255, 10, 20, 30, 40, 50, 60, 70, 80, 0, 90, 100, 110, 120, 130, 140, 150, 160,
        170, 180, 190, 200,
      ]),
    }),
  };
}
