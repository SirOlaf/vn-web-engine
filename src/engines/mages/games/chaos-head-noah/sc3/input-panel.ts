import {BrowserInput} from '../../../../../input/browser-input.js';
import type {NoahInput} from './input.js';

/** Live device diagnostic. Does not resume the VM past an unknown instruction. */
export function mountInputPanel(
  parent: HTMLElement,
  input: NoahInput,
  unlockAudio: () => void = () => {},
): () => void {
  const surface = document.createElement('div'),
    readout = document.createElement('pre');
  surface.textContent =
    'Input diagnostic · click or tap here, then use the keyboard or mouse wheel. VM execution remains stopped at the boundary above.';
  surface.setAttribute('aria-label', 'Game input diagnostic');
  surface.style.cssText =
    'aspect-ratio:16/9;max-width:640px;background:#171b24;padding:0;touch-action:none;outline-offset:3px';
  const device = new BrowserInput(surface, 1280, 720),
    abort = new AbortController();
  for (const event of ['pointerdown', 'keydown'])
    surface.addEventListener(event, unlockAudio, {signal: abort.signal});
  let previous = 0,
    frame = 0,
    lastEvent = 'none',
    disposed = false;
  const tick = (now: number) => {
    if (disposed) return;
    if (now - previous >= 1000 / 60) {
      previous = now;
      const f = device.sample();
      input.update(f);
      if (f.pressed.size || f.pressedButtons || f.wheel)
        lastEvent = `keys ${[...f.pressed].join(', ') || 'none'} · buttons ${f.pressedButtons} · wheel ${f.wheel}`;
      const s = input.state;
      readout.textContent = `Held 0x${(s.get(0x5a70d0) >>> 0).toString(16)} · pressed 0x${(s.get(0x5a70d4) >>> 0).toString(16)} · repeat 0x${(s.get(0x5a6f74) >>> 0).toString(16)}\nPointer ${f.x}, ${f.y} · inside ${f.inside} · held buttons ${f.buttons}\nLast event: ${lastEvent}`;
    }
    frame = requestAnimationFrame(tick);
  };
  parent.append(surface, readout);
  frame = requestAnimationFrame(tick);
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    abort.abort();
    device.dispose();
    surface.remove();
    readout.remove();
  };
}
