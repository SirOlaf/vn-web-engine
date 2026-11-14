import {spawn} from 'node:child_process';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';

// Diagnostic CPU owner only: Pillow/libjpeg, with no canvas or image display.
// Browser playback retains its existing browser codec and pixel rounding.
const program = `import sys, io, struct
from PIL import Image
image=Image.open(io.BytesIO(sys.stdin.buffer.read()))
image.load()
image=image.convert('RGBA')
sys.stdout.buffer.write(struct.pack('<II',*image.size)+image.tobytes())
`;
export async function decodeNodeOpaqueJpeg(input) {
  const header = readJpegHeader(input, true);
  if (header.components !== 3 || header.precision !== 8 || ![192, 194].includes(header.frameMarker))
    throw Error('Unsupported opaque JPEG layout');
  const expected = header.width * header.height * 4 + 8;
  if (!Number.isSafeInteger(expected) || expected > 512 * 1024 * 1024)
    throw Error('Unsupported diagnostic JPEG dimensions');
  const bytes = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ARTEMIS_PROBE_PYTHON ?? 'python3', ['-c', program], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let length = 0;
    const fail = () => reject(Error('Diagnostic JPEG decoder failed (requires Python Pillow)'));
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > expected) {
        child.kill();
        fail();
      } else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0 || length !== expected) fail();
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin.end(header.bytes);
  });
  if (bytes.readUInt32LE(0) !== header.width || bytes.readUInt32LE(4) !== header.height)
    throw Error('Diagnostic JPEG dimensions differ from stored frame');
  return {
    width: header.width,
    height: header.height,
    pixels: Uint8Array.from(bytes.subarray(8)),
    format: 2,
  };
}
