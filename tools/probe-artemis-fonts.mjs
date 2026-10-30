/** Read-only font tables/metrics probe. Never loads glyphs or produces pixels. */
import {createHash} from 'node:crypto';
import {openArtemisInstallation} from './artemis-installation.mjs';
import {FreeType} from '../dist/text/freetype.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {artemisFileFontMetrics} from '../dist/engines/artemis/file-fonts.js';
const [directory, path, ...argumentsSizes] = process.argv.slice(2);
if (!directory || !path || !argumentsSizes.length)
  throw Error('Usage: node tools/probe-artemis-fonts.mjs GAME_DIRECTORY FONT_PATH SIZE...');
const sizes = argumentsSizes.map(Number);
if (sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 255))
  throw Error('Font sizes must be integers from 1 to 255');
const installation = await openArtemisInstallation(directory);
let library;
try {
  const executable = await installation.files.read('hatsuyuki.exe');
  if (!executable) throw Error('Missing target executable');
  const executableSha256 = createHash('sha256').update(executable).digest('hex');
  artemisRevision(executableSha256);
  const bytes = await installation.files.read(path);
  if (!bytes) throw Error('Missing font file ' + path);
  library = new FreeType();
  const face = library.open(bytes);
  try {
    const metrics = sizes.map((size) => {
      face.requestSize(3, 0, size * 64);
      return {
        size,
        freeType: face.metrics,
        nativeFileFont: artemisFileFontMetrics(size, face.metrics),
      };
    });
    console.log(
      JSON.stringify(
        {
          executableSha256,
          fontPath: path,
          fontBytes: bytes.byteLength,
          fontSha256: createHash('sha256').update(bytes).digest('hex'),
          version: library.version,
          metrics,
          glyphsRasterized: 0,
          gameVisualAssetsDecoded: false,
        },
        null,
        2,
      ),
    );
  } finally {
    face.close();
  }
} finally {
  library?.close();
  await installation.close();
}
