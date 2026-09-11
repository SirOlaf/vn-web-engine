import {BrowserDomText} from './browser-dom-text.js';
import type {DrawCommand} from '../../../../../graphics/draw-list.js';
import type {TriangleImage} from '../../../../../graphics/triangle-draw.js';
import {BrowserNoahCursor, type NoahCursorResources} from './browser-cursor.js';
import {CanvasDrawTarget} from '../../../../../graphics/draw-list.js';
import {BrowserInput} from '../../../../../input/browser-input.js';
import type {Sc3Runtime} from './runtime.js';
import type {CapturedDialogFrame} from './dialog-canvas.js';
import {frameBatch} from '../../../../../core/frame-batch.js';

/** Run every native pass, including renderer state writes, retaining only the latest presentation frame. */
export function mountLivePlayer(
  create: () => Sc3Runtime,
  compose: (vm: Sc3Runtime, pass: number) => CapturedDialogFrame,
  unlock: () => Promise<void>,
  cursors: NoahCursorResources,
  presentation: 'diagnostic' | 'game' = 'diagnostic',
  onSidebarAvailability?: (available: boolean) => void,
): {panel: HTMLElement; start(): void; setTextMode(mode: 'native' | 'dom'): void; dispose(): void} {
  const panel = document.createElement('section'),
    canvas = document.createElement('canvas'),
    controls = document.createElement('div'),
    start = document.createElement('button'),
    fast = document.createElement('button'),
    readout = document.createElement('p'),
    details = document.createElement('details'),
    summary = document.createElement('summary'),
    trace = document.createElement('pre');
  canvas.style.cssText =
    'width:100%;max-width:1920px;aspect-ratio:16/9;touch-action:none;user-select:none;-webkit-touch-callout:none';
  canvas.setAttribute('aria-label', 'Game canvas');
  start.textContent = 'Start / restart';
  fast.textContent = 'Fast-forward · 8×';
  fast.setAttribute('aria-pressed', 'false');
  summary.textContent = 'Recent instruction trace';
  details.append(summary, trace);
  controls.append(start, fast);
  panel.append(canvas, controls, readout, details);
  panel.className = 'live-player';
  panel.style.position = 'relative';
  readout.style.zIndex = '1';
  readout.setAttribute('role', 'status');
  if (presentation === 'game') {
    controls.hidden = true;
    details.hidden = true;
    readout.hidden = true;
  }
  const domText = new BrowserDomText(panel, canvas);
  let textMode: 'native' | 'dom' = 'native',
    lastFrame: CapturedDialogFrame | undefined,
    lastCaptures = new Map<DrawCommand, TriangleImage>();
  const cursor = new BrowserNoahCursor(canvas, cursors);
  const target = new CanvasDrawTarget(canvas, 1920, 1080),
    device = new BrowserInput(canvas, 1920, 1080),
    abort = new AbortController();
  let vm: Sc3Runtime | undefined,
    running = false,
    busy = false,
    disposed = false,
    accelerated = false,
    pass = 0,
    previous = 0,
    animation = 0;
  const refreshTrace = () => {
    if (details.open && vm)
      trace.textContent = vm.trace
        .map(
          (t) =>
            `${t.context}/${t.asset} 0x${t.pc.toString(16)} → 0x${t.nextPc.toString(16)} ${t.operation} result=${t.result}`,
        )
        .join('\n');
  };
  const fail = (error: unknown) => {
    onSidebarAvailability?.(true);
    readout.hidden = false;
    running = false;
    cursor.clear();
    vm?.audio.dispose();
    vm?.movies.dispose();
    readout.textContent = `Game stopped: ${error instanceof Error ? error.message : String(error)}`;
    refreshTrace();
  };
  const unlockAudio = () => {
    void unlock().catch(fail);
  };
  for (const event of ['pointerdown', 'keydown'])
    canvas.addEventListener(event, unlockAudio, {signal: abort.signal});
  details.addEventListener('toggle', refreshTrace, {signal: abort.signal});
  fast.addEventListener(
    'click',
    () => {
      accelerated = !accelerated;
      fast.setAttribute('aria-pressed', String(accelerated));
      fast.textContent = accelerated ? 'Normal speed · 1×' : 'Fast-forward · 8×';
      canvas.focus();
    },
    {signal: abort.signal},
  );
  start.addEventListener(
    'click',
    async () => {
      if (busy || disposed) return;
      onSidebarAvailability?.(false);
      running = false;
      busy = true;
      start.disabled = true;
      domText.clear();
      lastFrame = undefined;
      lastCaptures.clear();
      cursor.clear();
      device.clear();
      vm?.audio.dispose();
      vm?.movies.dispose();
      target.dispose();
      try {
        await unlock();
        if (disposed) return;
        vm = create();
        cursor.bind(vm.input.cursor);
        await vm.boot();
        if (disposed) {
          vm.audio.dispose();
          vm.movies.dispose();
          return;
        }
        pass = 0;
        running = true;
        readout.textContent = 'Running';
        canvas.focus();
      } catch (error) {
        if (!disposed) fail(error);
      } finally {
        busy = false;
        start.disabled = false;
      }
    },
    {signal: abort.signal},
  );
  const advance = async () => {
    if (busy || !running || !vm || disposed) return;
    busy = true;
    start.disabled = true;
    const active = vm;
    try {
      const latest = await frameBatch(
        async () => {
          active.input.update(device.sample());
          let result = active.runFrame();
          while (result === 'blocked') {
            await active.waitHost();
            if (disposed) return;
            result = active.runFrame();
          }
          if (result === 'exited') {
            onSidebarAvailability?.(true);
            running = false;
            cursor.clear();
            device.clear();
            readout.hidden = false;
            readout.textContent = 'Game closed';
            return;
          }
          if (result === 'budget') throw new Error('Instruction budget exhausted');
          const frame = compose(active, ++pass);
          active.input.setRegions(frame.draw.regions);
          // Framebuffer copies and effects must execute even when presentation is batched.
          const captures = new Map<DrawCommand, TriangleImage>();
          target.draw(
            frame.draw,
            (id) => {
              const image = frame.textures.get(id);
              if (!image) throw new Error(`Missing texture ${id}`);
              return image;
            },
            (id, image, command) => {
              active.textures.publishRenderTarget(id, image);
              if (command) captures.set(command, image);
            },
          );
          lastFrame = frame;
          lastCaptures = captures;
          await active.settleLoads(false);
          if (disposed) return;
          active.publishLoadCompletions();
          if (active.loadErrors.length)
            throw new Error('Asset load failed', {cause: active.loadErrors[0]});
          return frame;
        },
        {
          frames: accelerated ? 8 : 1,
          milliseconds: 8,
          active: () => !disposed && running,
          now: () => performance.now(),
        },
      );
      if (latest) {
        if (textMode === 'dom') domText.show(latest, lastCaptures);
        if (running) onSidebarAvailability?.(latest.menuAllowsSidebar === true);
        readout.textContent = `${latest.label ?? 'Game'} · pass ${pass} · ${accelerated ? 'up to 8×' : '1×'}`;
      }
      refreshTrace();
    } catch (error) {
      if (!disposed) fail(error);
    } finally {
      busy = false;
      start.disabled = false;
    }
  };
  const tick = (now: number) => {
    if (disposed) return;
    if (now - previous >= 1000 / 60) {
      previous = now - ((now - previous) % (1000 / 60));
      void advance();
    }
    animation = requestAnimationFrame(tick);
  };
  readout.textContent =
    'Start the game, then click the canvas or use the keyboard. Fast-forward advances game frames; audio plays at normal speed.';
  animation = requestAnimationFrame(tick);
  return {
    panel,
    start() {
      start.click();
    },
    setTextMode(mode) {
      textMode = mode;
      device.clear();
      if (mode === 'native') domText.hide();
      else if (lastFrame) domText.show(lastFrame, lastCaptures);
    },
    dispose() {
      disposed = true;
      running = false;
      cancelAnimationFrame(animation);
      abort.abort();
      domText.dispose();
      cursor.dispose();
      device.dispose();
      target.dispose();
      vm?.audio.dispose();
      vm?.movies.dispose();
    },
  };
}
