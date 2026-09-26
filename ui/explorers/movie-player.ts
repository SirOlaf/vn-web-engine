import type {WorkerSource} from '../../src/core/worker-source.js';
import type {MovieInfo} from '../../src/formats/cri/movie.js';
import type {YuvFrame} from '../../src/video/frame.js';
import type {MovieRequest, MovieResponse} from '../../src/video/worker-protocol.js';
import {YuvRenderer} from '../../src/video/renderer.js';
/** Inspector adapter. AudioContext is the clock; suspension freezes audio and video together. */
export function mountMoviePlayer(parent: HTMLElement, source: WorkerSource): () => void {
  const panel = document.createElement('section');
  panel.className = 'movie-player';
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.setAttribute('aria-label', 'Movie picture');
  const controls = document.createElement('div');
  controls.className = 'audio-controls';
  const play = document.createElement('button');
  play.textContent = 'Play movie';
  const restart = document.createElement('button');
  restart.textContent = 'Restart';
  restart.disabled = true;
  const full = document.createElement('button');
  full.textContent = 'Fullscreen';
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '1';
  volume.step = '0.01';
  volume.value = '0.8';
  volume.setAttribute('aria-label', 'Movie volume');
  const volumeLabel = document.createElement('label');
  volumeLabel.append('Volume', volume);
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1';
  seek.step = '0.01';
  seek.value = '0';
  seek.disabled = true;
  seek.setAttribute('aria-label', 'Movie position');
  const time = document.createElement('output');
  time.textContent = '0:00';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'MPEG video and HCA audio decode in a worker as the movie plays.';
  controls.append(play, restart, full, volumeLabel);
  panel.append(canvas, controls, seek, time, status);
  parent.append(panel);
  let renderer: YuvRenderer | undefined,
    worker: Worker | undefined,
    context: AudioContext | undefined,
    gain: GainNode | undefined,
    info: MovieInfo | undefined;
  let queue: YuvFrame[] = [],
    done = false,
    pulling = false,
    wanted = false,
    buffering = true,
    epoch = 0,
    scheduledUntil = 0,
    disposed = false,
    generation = 0,
    raf = 0,
    seeking = false,
    resuming = false,
    finished = false,
    suspending = false;
  const nodes = new Set<AudioBufferSourceNode>();
  const format = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const send = (message: MovieRequest) => worker?.postMessage(message);
  function close(): void {
    generation++;
    worker?.terminate();
    worker = undefined;
    for (const node of nodes) {
      try {
        node.stop();
      } catch {}
      node.disconnect();
    }
    nodes.clear();
    void context?.close().catch(() => {});
    context = undefined;
    gain = undefined;
    queue = [];
    pulling = false;
  }
  function fail(error: unknown): void {
    if (disposed) return;
    close();
    wanted = false;
    finished = false;
    play.textContent = 'Retry movie';
    play.disabled = false;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  function pull(): void {
    if (worker && !pulling && !done && queue.length < 8) {
      pulling = true;
      send({type: 'pull'});
    }
  }
  async function resumeIfReady(): Promise<void> {
    const ctx = context;
    if (!ctx || !wanted || resuming || suspending || !buffering) return;
    const t = Math.max(0, ctx.currentTime - epoch),
      videoReady = done || queue.length >= 4,
      audioReady = done || scheduledUntil >= Math.min(info?.duration ?? Infinity, t + 0.1);
    if (!videoReady || !audioReady) {
      pull();
      return;
    }
    resuming = true;
    const token = generation;
    try {
      await ctx.resume();
      if (token !== generation) return;
      if (!wanted) {
        await ctx.suspend();
        return;
      }
      buffering = false;
      seeking = false;
      status.textContent = `${info!.width} × ${info!.height} · ${info!.frameRate.toFixed(3)} fps · MPEG-1 + HCA`;
    } catch (error) {
      if (token === generation) fail(error);
    } finally {
      if (token === generation) resuming = false;
    }
  }
  async function start(position = 0): Promise<void> {
    close();
    const token = generation;
    done = false;
    finished = false;
    wanted = true;
    buffering = true;
    seeking = position > 0;
    resuming = false;
    suspending = false;
    scheduledUntil = position;
    seek.value = String(position);
    time.textContent = `${format(position)} / ${format(info?.duration ?? 0)}`;
    play.textContent = 'Pause';
    restart.disabled = false;
    status.textContent = position ? 'Seeking from the start…' : 'Buffering movie…';
    try {
      renderer ??= new YuvRenderer(canvas);
      const ctx = new AudioContext();
      context = ctx;
      gain = ctx.createGain();
      gain.gain.value = Number(volume.value);
      gain.connect(ctx.destination);
      // Created/resumed in the user gesture, then suspended while decoder fills its queues.
      await ctx.resume();
      await ctx.suspend();
      if (token !== generation) return;
      epoch = ctx.currentTime - position + 0.05;
      worker = new Worker(new URL('../../src/video/decode-worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onerror = (event) => {
        if (token === generation) fail(new Error(event.message || 'Movie worker failed'));
      };
      worker.onmessage = (event: MessageEvent<MovieResponse>) => {
        if (token !== generation || disposed) return;
        try {
          const b = event.data;
          if (b.type === 'error') {
            fail(new Error(b.message));
            return;
          }
          if (b.type === 'seeking') {
            if (wanted)
              status.textContent = seeking
                ? `Seeking… ${(b.progress * 100).toFixed(0)}%`
                : 'Buffering movie…';
            return;
          }
          pulling = false;
          info = b.info;
          done = b.done;
          seek.disabled = false;
          seek.max = String(info.duration);
          queue.push(...b.frames);
          // Merge this response's contiguous PCM into one Web Audio buffer.
          if (b.audio.length) {
            const first = b.audio[0]!,
              count = b.audio.reduce((n, a) => n + a.channels[0]!.length, 0),
              buffer = ctx.createBuffer(info.channels, count, info.sampleRate);
            let offset = 0;
            for (const a of b.audio) {
              if (a.start !== first.start + offset) throw new Error('Non-contiguous movie PCM');
              for (let c = 0; c < info.channels; c++)
                buffer.getChannelData(c).set(a.channels[c]!, offset);
              offset += a.channels[0]!.length;
            }
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            node.connect(gain!);
            nodes.add(node);
            node.onended = () => {
              nodes.delete(node);
              node.disconnect();
            };
            const at = epoch + first.start / info.sampleRate;
            if (at + 0.01 < ctx.currentTime) throw new Error('Movie audio buffer underrun');
            node.start(at);
            scheduledUntil = (first.start + count) / info.sampleRate;
          }
          if (buffering && queue.length) renderer!.draw(queue[0]!);
          if (!wanted) status.textContent = 'Paused.';
          pull();
          void resumeIfReady();
        } catch (error) {
          fail(error);
        }
      };
      pulling = true;
      send({type: 'open', source, seek: position});
    } catch (error) {
      if (token === generation) fail(error);
    }
  }
  function tick(): void {
    if (disposed) return;
    try {
      const ctx = context;
      if (ctx && info && wanted && !buffering) {
        const t = Math.max(0, ctx.currentTime - epoch);
        let frame: YuvFrame | undefined;
        while (queue.length && queue[0]!.index / info.frameRate <= t) frame = queue.shift();
        if (frame) renderer!.draw(frame);
        seek.value = String(Math.min(t, info.duration));
        time.textContent = `${format(t)} / ${format(info.duration)}`;
        if (t >= info.duration && done) {
          wanted = false;
          finished = true;
          play.textContent = 'Replay';
          void ctx.suspend();
          status.textContent = 'Movie complete.';
        } else if (
          !done &&
          ((!queue.length && t < (info.frameCount - 1) / info.frameRate) ||
            scheduledUntil - t < 0.06)
        ) {
          buffering = true;
          status.textContent = 'Buffering movie…';
          const token = generation;
          suspending = true;
          void ctx
            .suspend()
            .then(() => {
              if (token === generation) {
                suspending = false;
                void resumeIfReady();
              }
            })
            .catch((error) => {
              if (token === generation) fail(error);
            });
        }
        pull();
      }
    } catch (error) {
      fail(error);
    }
    raf = requestAnimationFrame(tick);
  }
  play.onclick = () => {
    if (!context || finished) {
      void start();
      return;
    }
    wanted = !wanted;
    play.textContent = wanted ? 'Pause' : 'Play';
    if (wanted) {
      buffering = true;
      void resumeIfReady();
    } else {
      const ctx = context;
      void ctx.suspend().catch(fail);
      status.textContent = 'Paused.';
    }
  };
  restart.onclick = () => void start();
  seek.onchange = () =>
    void start(Math.min(Number(seek.value), Math.max(0, (info?.duration ?? 0) - 0.1)));
  volume.oninput = () => {
    if (gain) gain.gain.value = Number(volume.value);
  };
  full.disabled = !panel.requestFullscreen;
  full.onclick = () => {
    void (document.fullscreenElement ? document.exitFullscreen() : panel.requestFullscreen()).catch(
      (error) => {
        status.textContent = String(error);
      },
    );
  };
  const fullscreen = () => {
    full.textContent = document.fullscreenElement === panel ? 'Exit fullscreen' : 'Fullscreen';
  };
  document.addEventListener('fullscreenchange', fullscreen);
  const visibility = () => {
    if (document.hidden && context && wanted) {
      wanted = false;
      play.textContent = 'Play';
      void context.suspend().catch(fail);
      status.textContent = 'Paused while the page is hidden.';
    }
  };
  document.addEventListener('visibilitychange', visibility);
  raf = requestAnimationFrame(tick);
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('fullscreenchange', fullscreen);
    close();
    renderer?.dispose();
    panel.remove();
  };
}
