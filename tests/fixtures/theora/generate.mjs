// Synthetic FFmpeg test patterns only. References come from libtheora's own decoder.
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const ffmpeg = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const cc = process.env.CC ?? 'cc';
const prefix = process.env.LIBTHEORA_PREFIX ?? '/opt/homebrew';
const directory = new URL('./', import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oracle = join(mkdtempSync(join(tmpdir(), 'theora-')), 'libtheora-frames');
execFileSync(cc, [
  '-O2',
  `-I${prefix}/include`,
  fileURLToPath(new URL('libtheora-frames.c', directory)),
  `-L${prefix}/lib`,
  '-ltheoradec',
  '-logg',
  '-o',
  oracle,
]);
const clips = [
  // Odd picture size inside a padded frame, two keyframes and inter frames.
  {
    name: 'testsrc2-420',
    source: 'testsrc2=size=72x40:rate=30',
    frames: 40,
    pix: 'yuv420p',
    args: ['-q:v', '4', '-g', '15'],
  },
  // Zooming fractal under a bitrate target: motion vectors, four-vector and golden modes.
  {
    name: 'mandelbrot-420',
    source: 'mandelbrot=size=96x80:rate=30',
    frames: 30,
    pix: 'yuv420p',
    args: ['-b:v', '300k'],
  },
  {
    name: 'testsrc2-422',
    source: 'testsrc2=size=80x48:rate=30',
    frames: 20,
    pix: 'yuv422p',
    args: ['-q:v', '5'],
  },
  {
    name: 'testsrc2-444',
    source: 'testsrc2=size=80x48:rate=30',
    frames: 20,
    pix: 'yuv444p',
    args: ['-q:v', '5'],
  },
];
const manifest = {
  ffmpeg: execFileSync(ffmpeg, ['-version'], {encoding: 'utf8'}).split('\n')[0],
  clips: [],
};
for (const clip of clips) {
  const file = new URL(clip.name + '.ogv', directory);
  // prettier-ignore
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', clip.source,
    '-frames:v', String(clip.frames), '-pix_fmt', clip.pix, '-c:v', 'libtheora', ...clip.args,
    '-map_metadata', '-1', '-fflags', '+bitexact', fileURLToPath(file)]);
  const result = spawnSync('sh', ['-c', '"$0" < "$1"', oracle, fileURLToPath(file)], {
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) throw Error(String(result.stderr));
  const [, width, height, format] = /frame (\d+)x(\d+) .* fmt (\d)/.exec(String(result.stderr));
  const luma = width * height,
    chroma = (format & 1 ? width : width / 2) * (format & 2 ? height : height / 2);
  const size = luma + 2 * chroma,
    output = result.stdout;
  const frames = [];
  for (let offset = 0; offset < output.length; offset += size)
    frames.push(hash(output.subarray(offset, offset + size)));
  manifest.clips.push({
    name: clip.name,
    source: clip.source,
    width: +width,
    height: +height,
    format: +format,
    file: hash(readFileSync(file)),
    frames,
  });
}
writeFileSync(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n');
