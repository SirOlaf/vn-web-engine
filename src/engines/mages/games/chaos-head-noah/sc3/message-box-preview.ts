import type {Sc3Runtime} from './runtime.js';
import {romByte} from './text-rom.js';
import {BitmapFont} from '../../../../../graphics/bitmap-font.js';
import {Surface} from '../../../../../graphics/surface.js';
import {SurfacePresenter} from '../../../../../graphics/surface-presenter.js';

/** Retained diagnostic frames make even an immediately dismissed dialog inspectable.
 * The neutral frame is diagnostic UI; glyph cells/advances follow 140045830. */
export function messageBoxPreviews(vm: Sc3Runtime): HTMLElement {
  const panel = document.createElement('section'),
    title = document.createElement('h3');
  title.textContent = 'Startup message boxes · retained frames';
  panel.append(title);
  const resource = vm.textures.resources.get(91);
  if (!resource) {
    panel.append('Font texture 91 is unavailable.');
    return panel;
  }
  const atlas = new BitmapFont(resource.pending ?? resource.image);
  const identity = (address: number) => {
    for (let slot = 0; slot < vm.messages.length; slot++) {
      const mes = vm.messages[slot];
      if (!mes) continue;
      for (const id of mes.byId.keys()) {
        // Resolve through the runtime's actual buffer identity, not a guessed slot base.
        if (vm.messageAddress(slot, id) === address)
          return `MES slot ${slot}, ID ${id} (0x${id.toString(16)})`;
      }
    }
    return `script text at 0x${address.toString(16)}`;
  };
  const glyphs = (address: number) => {
    const ids: number[] = [];
    for (let guard = 0; guard < 4096; guard++) {
      const byte = vm.dataByte(address++);
      if (byte === 255) return ids;
      if (byte >= 128) {
        ids.push((byte & 127) * 256 + vm.dataByte(address++));
        continue;
      }
      if (byte === 4) {
        while (vm.dataByte(address) !== 0) {
          const k = vm.dataByte(address);
          address += k >= 128 && k & 96 ? ((k & 96) === 32 ? 3 : (k & 96) === 64 ? 4 : 6) : 2;
        }
        address++;
        continue;
      }
      if ([0, 9, 11, 30].includes(byte)) continue;
      throw new Error(`Unsupported diagnostic text control ${byte}`);
    }
    throw new Error('Diagnostic text did not terminate');
  };
  try {
    for (const snapshot of vm.messageBoxes.snapshots) {
      const caption = document.createElement('p'),
        canvas = document.createElement('canvas'),
        surface = new Surface(1280, 720);
      caption.textContent = `Channel ${snapshot.channel} · ${snapshot.lines.map(identity).join(' · ')}. Game atlas text; neutral diagnostic frame, held at full opacity.`;
      canvas.style.cssText = 'width:100%;max-width:1280px;aspect-ratio:16/9';
      canvas.setAttribute('aria-label', caption.textContent);
      surface.clear([8, 12, 18, 255]);
      surface.clear([32, 40, 54, 255], {x: 160, y: 220, width: 960, height: 280});
      let y = 283;
      for (const address of [...snapshot.lines, ...snapshot.choices]) {
        const ids = glyphs(address),
          widths = ids.map(
            (id) => ((id < 351 ? romByte(0x1da350 + id) : id < 0x2800 ? 32 : 17) * 24) >>> 5,
          ),
          total = widths.reduce((a, b) => a + b, 0);
        let x = 214;
        ids.forEach((id, i) => {
          const raw = id < 351 ? romByte(0x1da350 + id) : id < 0x2800 ? 32 : 17,
            w =
              total > snapshot.width
                ? Math.floor((snapshot.width * widths[i]!) / total)
                : widths[i]!;
          if (raw && w) {
            const crop = atlas.glyph({
              x: (id % 64) * 48,
              y: Math.floor(id / 64) * 48,
              width: 48,
              height: 48,
            });
            const offset = id < 384 ? (((romByte(0x1d9f00 + id) << 24) >> 24) * 24) >> 5 : 0;
            surface.blit(crop, {
              source: {x: 0, y: 0, width: raw * 1.5, height: 48},
              destination: {x, y: y + offset, width: w, height: 24},
              filter: 'linear',
            });
          }
          x += w;
        });
        y += snapshot.lines.length < 5 ? 32 : 28;
      }
      new SurfacePresenter(canvas).present(surface);
      surface.dispose();
      panel.append(caption, canvas);
    }
  } finally {
    atlas.dispose();
  }
  if (!vm.messageBoxes.snapshots.length) panel.append('No message box has been opened.');
  return panel;
}
