import {encodeWav} from './pcm.js';
import type {PcmClip} from './pcm.js';
import type {AudioResponse, AudioSource} from './worker-protocol.js';
/** Inspector playback host; codec modules have no DOM or AudioContext dependencies. */
export function mountAudioPlayer(
  container: HTMLElement,
  source: AudioSource,
  filename: string,
): () => void {
  const panel = document.createElement('div');
  panel.className = 'audio-player';
  container.append(panel);
  const info = document.createElement('p'),
    status = document.createElement('p');
  status.setAttribute('role', 'status');
  const decode = document.createElement('button');
  decode.textContent = 'Decode audio';
  const play = document.createElement('button');
  play.textContent = 'Play';
  play.disabled = true;
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.disabled = true;
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '0';
  seek.step = '0.01';
  seek.value = '0';
  seek.disabled = true;
  seek.setAttribute('aria-label', 'Playback position');
  const time = document.createElement('output');
  time.textContent = '0:00 / 0:00';
  const loopLabel = document.createElement('label'),
    loop = document.createElement('input');
  loop.type = 'checkbox';
  loop.disabled = true;
  loopLabel.append(loop, ' Use embedded loop');
  const volumeLabel = document.createElement('label'),
    volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.01';
  volume.value = '0.7';
  volume.setAttribute('aria-label', 'Volume');
  volumeLabel.append('Volume ', volume);
  const save = document.createElement('button');
  save.textContent = 'Save WAV';
  save.disabled = true;
  const controls = document.createElement('div');
  controls.className = 'audio-controls';
  controls.append(decode, play, stop, loopLabel, save);
  panel.append(info, controls, seek, time, volumeLabel, status);
  let worker: Worker | undefined,
    clip: PcmClip | undefined,
    context: AudioContext | undefined,
    buffer: AudioBuffer | undefined,
    gain: GainNode | undefined,
    node: AudioBufferSourceNode | undefined;
  let offset = 0,
    started = 0,
    disposed = false,
    frame = 0,
    wavUrl: string | undefined,
    playRequest = 0;
  const duration = () => (clip ? clip.sampleCount / clip.sampleRate : 0);
  const formatTime = (seconds: number) => {
    const ticks = Math.max(0, Math.floor(seconds * 100));
    return `${Math.floor(ticks / 6000)}:${((ticks % 6000) / 100).toFixed(2).padStart(5, '0')}`;
  };
  function position(): number {
    let p = offset + (node && context ? context.currentTime - started : 0);
    if (node?.loop && clip?.loop) {
      const a = clip.loop.start / clip.sampleRate,
        b = clip.loop.end / clip.sampleRate;
      if (p >= b) p = a + ((p - a) % (b - a));
    }
    return Math.min(duration(), p);
  }
  function display(): void {
    const p = position();
    seek.value = String(p);
    time.textContent = `${formatTime(p)} / ${formatTime(duration())}`;
  }
  function pause(): void {
    playRequest++;
    offset = position();
    if (node) {
      node.onended = null;
      node.stop();
      node.disconnect();
      node = undefined;
    }
    play.textContent = 'Play';
    cancelAnimationFrame(frame);
    display();
  }
  function tick(): void {
    if (disposed || !node) return;
    display();
    frame = requestAnimationFrame(tick);
  }
  async function start(): Promise<void> {
    if (!clip || disposed) return;
    const request = ++playRequest;
    try {
      context ??= new AudioContext();
      await context.resume();
      if (disposed || request !== playRequest) return;
      if (!buffer) {
        buffer = context.createBuffer(clip.channels.length, clip.sampleCount, clip.sampleRate);
        clip.channels.forEach((channel, i) =>
          buffer!.copyToChannel(channel as Float32Array<ArrayBuffer>, i),
        );
        gain = context.createGain();
        gain.gain.value = Number(volume.value);
        gain.connect(context.destination);
      }
      if (offset >= duration()) offset = 0;
      if (loop.checked && clip.loop && offset >= clip.loop.end / clip.sampleRate)
        offset = clip.loop.start / clip.sampleRate;
      const current = context.createBufferSource();
      current.buffer = buffer;
      current.loop = loop.checked;
      if (clip.loop) {
        current.loopStart = clip.loop.start / clip.sampleRate;
        current.loopEnd = clip.loop.end / clip.sampleRate;
      }
      current.connect(gain!);
      current.onended = () => {
        if (node !== current) return;
        current.disconnect();
        node = undefined;
        offset = duration();
        play.textContent = 'Play';
        cancelAnimationFrame(frame);
        display();
      };
      node = current;
      started = context.currentTime;
      current.start(0, offset);
      play.textContent = 'Pause';
      tick();
    } catch (error) {
      if (!disposed)
        status.textContent = `Playback failed: ${error instanceof Error ? error.message : error}`;
    }
  }
  play.onclick = () => {
    if (node) pause();
    else void start();
  };
  stop.onclick = () => {
    pause();
    offset = 0;
    display();
  };
  seek.oninput = () => {
    const requested = Number(seek.value),
      playing = !!node;
    pause();
    offset = requested;
    display();
    if (playing) void start();
  };
  loop.onchange = () => {
    const playing = !!node;
    pause();
    if (playing) void start();
  };
  volume.oninput = () => {
    if (gain && context) gain.gain.setValueAtTime(Number(volume.value), context.currentTime);
  };
  save.onclick = () => {
    if (!clip) return;
    try {
      if (!wavUrl)
        wavUrl = URL.createObjectURL(
          new Blob([encodeWav(clip).buffer as ArrayBuffer], {type: 'audio/wav'}),
        );
      const link = document.createElement('a');
      link.href = wavUrl;
      link.download = `${filename}.wav`;
      link.click();
    } catch (error) {
      status.textContent = `WAV export failed: ${error instanceof Error ? error.message : error}`;
    }
  };
  decode.onclick = () => {
    decode.disabled = true;
    status.textContent = 'Reading HCA header…';
    const fail = (message: string) => {
      status.textContent = message;
      worker?.terminate();
      worker = undefined;
      decode.disabled = false;
    };
    try {
      worker = new Worker(new URL('./decode-worker.js', import.meta.url), {type: 'module'});
    } catch (error) {
      fail(`Cannot start audio worker: ${error instanceof Error ? error.message : error}`);
      return;
    }
    worker.onerror = (event) => fail(`Audio worker failed: ${event.message}`);
    worker.onmessage = (event: MessageEvent<AudioResponse>) => {
      if (disposed) return;
      const message = event.data;
      if (message.type === 'header') {
        const h = message.header;
        info.textContent = `HCA 2.0 · ${h.channels === 1 ? 'Mono' : 'Stereo'} · ${h.sampleRate.toLocaleString()} Hz · ${formatTime(h.sampleCount / h.sampleRate)}${h.loop ? ` · loop ${formatTime(h.loop.start / h.sampleRate)}–${formatTime(h.loop.end / h.sampleRate)}` : ''}`;
      } else if (message.type === 'progress')
        status.textContent = `Decoding ${Math.round(message.fraction * 100)}%…`;
      else if (message.type === 'error') fail(message.message);
      else {
        clip = message.clip;
        worker?.terminate();
        worker = undefined;
        play.disabled = false;
        stop.disabled = false;
        seek.disabled = false;
        save.disabled = false;
        loop.disabled = !clip.loop;
        loop.checked = !!clip.loop;
        seek.max = String(duration());
        decode.textContent = 'Decoded';
        display();
        status.textContent = `Decoded ${clip.sampleCount.toLocaleString()} samples/channel in ${(message.elapsedMs / 1000).toFixed(2)} s. Ready to play.`;
      }
    };
    worker.postMessage({type: 'decode', source});
  };
  return () => {
    disposed = true;
    pause();
    worker?.terminate();
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    if (context) void context.close();
    panel.remove();
  };
}
