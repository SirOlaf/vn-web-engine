// Synthetic FFmpeg test pattern and the project's synthetic MP2 tone only.
import {execFileSync} from 'node:child_process';
import {writeFileSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const ffmpeg = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const ffprobe = process.env.FFPROBE ?? '/opt/homebrew/bin/ffprobe';
const directory = new URL('./', import.meta.url);
const fixtures = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const audio of [false, true]) {
  const name = audio ? 'delayed-audio' : 'video-only';
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=30:duration=0.6',
  ];
  if (audio)
    args.push(
      '-itsoffset',
      '0.08',
      '-i',
      fileURLToPath(new URL('../mp2/tone-48000-2.mp2', import.meta.url)),
    );
  args.push('-map', '0:v', '-c:v', 'mpeg1video', '-g', '6', '-bf', '2', '-q:v', '4');
  if (audio) args.push('-map', '1:a', '-c:a', 'copy');
  args.push('-f', 'mpeg', 'pipe:1');
  const encoded = execFileSync(ffmpeg, args);
  const filename = new URL(name + '.mpg', directory);
  writeFileSync(filename, encoded);
  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      ['-v', 'error', '-show_frames', '-show_streams', '-of', 'json', fileURLToPath(filename)],
      {encoding: 'utf8'},
    ),
  );
  const video = execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    fileURLToPath(filename),
    '-map',
    '0:v',
    '-fps_mode',
    'passthrough',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  writeFileSync(new URL(name + '.yuv.gz', directory), gzipSync(video));
  let pcm = Buffer.alloc(0);
  if (audio) {
    pcm = execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-c:a',
      'mp2float',
      '-i',
      fileURLToPath(filename),
      '-map',
      '0:a',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    writeFileSync(new URL(name + '.f32.gz', directory), gzipSync(pcm));
  }
  fixtures.push({
    name,
    width: 64,
    height: 48,
    frameRate: 30,
    sampleRate: audio ? 48000 : 0,
    channels: audio ? 2 : 0,
    frameCount: video.length / (64 * 48 * 1.5),
    videoStart: 0,
    audioStart: audio ? 0.08 : null,
    probeVideoPts: probe.frames
      .filter((f) => f.media_type === 'video')
      .map((f) => f.best_effort_timestamp),
    pictureTypes: probe.frames.filter((f) => f.media_type === 'video').map((f) => f.pict_type),
    audioPts: probe.frames
      .filter((f) => f.media_type === 'audio')
      .map((f) => f.best_effort_timestamp),
    encodedSha256: hash(encoded),
    yuvSha256: hash(video),
    pcmSha256: hash(pcm),
  });
}
writeFileSync(
  new URL('manifest.json', directory),
  JSON.stringify(
    {reference: execFileSync(ffmpeg, ['-version'], {encoding: 'utf8'}).split('\n')[0], fixtures},
    null,
    2,
  ) + '\n',
);
