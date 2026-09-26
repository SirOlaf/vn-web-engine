import {BlobSource, SliceSource, type ByteSource} from '../../src/core/source.js';
import {Arc20Archive} from '../../src/formats/buriko/arc20.js';
import {signature} from '../../src/formats/buriko/binary.js';
import {imageRgba, type AssetInspection} from '../../src/engines/buriko/assets.js';
import type {ExplorerRequest, ExplorerSource} from '../../src/engines/buriko/explorer-worker.js';
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node as T;
}
const select = el<HTMLSelectElement>('archives'),
  filter = el<HTMLInputElement>('filter'),
  list = el('entries'),
  viewer = el('viewer'),
  status = el('status');
interface Mount {
  name: string;
  source: ByteSource;
  archive?: Arc20Archive;
}
const mounts: Mount[] = [];
let page = 0,
  generation = 0,
  loadGeneration = 0;
let cleanup: (() => void)[] = [];
function clear(): number {
  generation++;
  for (const dispose of cleanup) dispose();
  cleanup = [];
  viewer.replaceChildren();
  return generation;
}
function report(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const b = node('button', text);
  b.onclick = action;
  return b;
}
function descriptor(input: ByteSource): ExplorerSource {
  let offset = 0,
    size = input.size;
  while (input instanceof SliceSource) {
    offset += input.offset;
    input = input.source;
  }
  if (input instanceof BlobSource)
    return {kind: 'blob', blob: input.blob.slice(offset, offset + size)};
  throw new Error('Source cannot be transferred to decoder');
}
function workerClient() {
  const worker = new Worker(
    new URL('../../src/engines/buriko/explorer-worker.ts', import.meta.url),
    {type: 'module'},
  );
  let serial = 0;
  const pending = new Map<
    number,
    {resolve: (value: unknown) => void; reject: (error: Error) => void}
  >();
  const fail = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  worker.onmessage = (event) => {
    const p = pending.get(event.data.id);
    if (!p) return;
    pending.delete(event.data.id);
    if (event.data.error) p.reject(new Error(event.data.error));
    else p.resolve(event.data.result);
  };
  worker.onerror = (event) => fail(new Error(event.message || 'Decoder worker failed'));
  cleanup.push(() => {
    worker.terminate();
    fail(new Error('Preview closed'));
  });
  return <T>(
    request:
      | Omit<Extract<ExplorerRequest, {type: 'inspect'}>, 'id'>
      | Omit<Extract<ExplorerRequest, {type: 'movie'}>, 'id'>
      | Omit<Extract<ExplorerRequest, {type: 'frame'}>, 'id'>,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, {resolve: (value) => resolve(value as T), reject});
      worker.postMessage({...request, id});
    });
}
function download(
  bytes: Uint8Array,
  name: string,
  mime = 'application/octet-stream',
): HTMLAnchorElement {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {type: mime}));
  cleanup.push(() => URL.revokeObjectURL(url));
  const link = node('a', `Save ${name}`);
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, '_');
  return link;
}
function details(title: string, text: string): void {
  const d = node('details');
  d.append(node('summary', title), node('pre', text));
  viewer.append(d);
}
function hex(bytes: Uint8Array, offset: number, length: number): string {
  const lines: string[] = [];
  for (let p = offset; p < Math.min(bytes.length, offset + length); p += 16) {
    const row = bytes.subarray(p, Math.min(p + 16, bytes.length));
    lines.push(
      `${p.toString(16).padStart(8, '0')}  ${Array.from(row, (b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(
          47,
        )}  ${Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`,
    );
  }
  return lines.join('\n');
}
function byteInspector(bytes: Uint8Array): void {
  const d = node('details'),
    controls = node('div'),
    input = node('input'),
    pre = node('pre');
  controls.className = 'preview-controls';
  input.type = 'number';
  input.min = '0';
  input.max = String(Math.max(0, bytes.length - 1));
  input.step = '4096';
  input.value = '0';
  input.setAttribute('aria-label', 'Byte offset');
  const render = () => {
    const p = Number(input.value);
    if (Number.isInteger(p) && p >= 0 && p < bytes.length) pre.textContent = hex(bytes, p, 4096);
  };
  input.oninput = render;
  controls.append(node('label', 'Byte offset'), input);
  d.append(node('summary', `Decoded bytes (${bytes.length.toLocaleString()})`), controls, pre);
  render();
  viewer.append(d);
}
function saveCanvas(canvas: HTMLCanvasElement, name: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob),
      link = node('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
function showImage(result: AssetInspection): void {
  const image = result.image!,
    canvas = node('canvas'),
    context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D unavailable');
  canvas.width = image.width;
  canvas.height = image.height;
  const controls = node('div'),
    mode = node('select');
  controls.className = 'preview-controls';
  for (const [v, t] of [
    ['color', 'Color + alpha'],
    ['rgb', 'RGB only'],
    ['alpha', 'Alpha channel'],
  ])
    mode.add(new Option(t!, v));
  const draw = () =>
    context.putImageData(
      new ImageData(
        imageRgba(image, mode.value as 'color' | 'rgb' | 'alpha'),
        image.width,
        image.height,
      ),
      0,
      0,
    );
  mode.onchange = draw;
  controls.append(
    mode,
    button('Fit / actual size', () => canvas.classList.toggle('actual-size')),
    button('Save preview PNG', () => saveCanvas(canvas, 'preview.png')),
  );
  viewer.append(controls, canvas);
  draw();
}
async function showMovie(source: ByteSource, token: number): Promise<void> {
  const request = workerClient(),
    info = await request<{
      width: number;
      height: number;
      bitDepth: number;
      surfaceType: number;
      fps: number;
      frameCount: number;
    }>({type: 'movie', source: descriptor(source)});
  if (token !== generation) return;
  details('Movie metadata', JSON.stringify(info, null, 2));
  const canvas = node('canvas'),
    context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  canvas.width = info.width;
  canvas.height = info.height;
  const controls = node('div'),
    slider = node('input'),
    label = node('span'),
    mode = node('select');
  for (const [value, title] of [
    ['color', 'Color + alpha'],
    ['rgb', 'RGB only'],
    ['alpha', 'Alpha channel'],
  ])
    mode.add(new Option(title!, value));
  mode.setAttribute('aria-label', 'Movie channels');
  controls.className = 'preview-controls';
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(info.frameCount - 1);
  slider.value = '0';
  slider.step = '1';
  slider.setAttribute('aria-label', 'Movie frame');
  const frames = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
  let selection = 0,
    playing = false,
    timer = 0,
    decoding = false;
  const draw = (index: number) => {
    const pixels = frames.get(index);
    if (pixels) {
      const display = mode.value === 'color' ? pixels : pixels.slice();
      if (mode.value !== 'color')
        for (let p = 0; p < display.length; p += 4) {
          if (mode.value === 'alpha')
            display[p] = display[p + 1] = display[p + 2] = display[p + 3]!;
          display[p + 3] = 255;
        }
      context.putImageData(new ImageData(display, info.width, info.height), 0, 0);
      slider.value = String(index);
      label.textContent = `Frame ${index + 1} / ${info.frameCount} · ${info.fps} fps`;
    }
  };
  const fetchFrame = async (index: number) => {
    if (!frames.has(index)) {
      const pixels = await request<Uint8ClampedArray<ArrayBuffer>>({type: 'frame', index});
      if (token !== generation) return;
      frames.set(index, pixels);
    }
    draw(index);
  };
  const stop = () => {
    playing = false;
    clearTimeout(timer);
  };
  cleanup.push(stop);
  const play = button(
    'Prepare & play',
    () =>
      void (async () => {
        if (playing) {
          stop();
          play.textContent = 'Play';
          return;
        }
        if (decoding) return;
        if (info.width * info.height * 4 * info.frameCount > 512 * 1024 * 1024) {
          report('Movie exceeds the 512 MiB playback cache limit; use frame stepping.');
          return;
        }
        decoding = true;
        play.disabled = true;
        slider.disabled = true;
        try {
          for (let i = 0; i < info.frameCount; i++) {
            if (token !== generation) return;
            if (!frames.has(i))
              frames.set(
                i,
                await request<Uint8ClampedArray<ArrayBuffer>>({type: 'frame', index: i}),
              );
            status.textContent = `Preparing movie · ${i + 1} / ${info.frameCount}`;
          }
          if (token !== generation) return;
          playing = true;
          play.textContent = 'Pause';
          const start = performance.now() - (Number(slider.value) * 1000) / info.fps;
          const tick = () => {
            if (!playing || token !== generation) return;
            const index =
              Math.floor(((performance.now() - start) * info.fps) / 1000) % info.frameCount;
            draw(index);
            timer = window.setTimeout(tick, Math.max(4, 1000 / info.fps / 2));
          };
          tick();
          status.textContent = 'Movie ready.';
        } catch (error) {
          if (token === generation) report(error);
        } finally {
          decoding = false;
          play.disabled = false;
          slider.disabled = false;
        }
      })(),
  );
  slider.oninput = () => {
    stop();
    play.textContent = 'Play';
    const own = ++selection;
    slider.disabled = true;
    void fetchFrame(Number(slider.value))
      .catch((error) => {
        if (token === generation && own === selection) report(error);
      })
      .finally(() => {
        slider.disabled = false;
      });
  };
  mode.onchange = () => draw(Number(slider.value));
  controls.append(
    play,
    slider,
    label,
    mode,
    button('Save frame PNG', () => saveCanvas(canvas, `frame-${slider.value}.png`)),
    button('Fit / actual size', () => canvas.classList.toggle('actual-size')),
  );
  viewer.append(controls, canvas);
  await fetchFrame(0);
}
async function preview(mount: Mount, index: number): Promise<void> {
  const token = clear(),
    entry = mount.archive?.entries[index],
    source = mount.archive ? mount.archive.entrySource(index) : mount.source,
    name = entry?.name ?? mount.name;
  status.textContent = `Reading ${mount.name} / ${name}…`;
  try {
    const heading = node('h2', `${mount.name}${entry ? ` / ${entry.index} · ${name}` : ''}`);
    viewer.append(heading);
    const storedButton = button(
      'Save stored asset',
      () =>
        void (async () => {
          storedButton.disabled = true;
          try {
            const bytes = await source.read(0, source.size);
            if (token !== generation) return;
            const link = download(bytes, name);
            link.click();
          } catch (error) {
            if (token === generation) report(error);
          } finally {
            storedButton.disabled = false;
          }
        })(),
    );
    viewer.append(storedButton);
    if (entry)
      details(
        'Archive record',
        JSON.stringify(
          {
            index: entry.index,
            offset: entry.offset,
            storedBytes: entry.size,
            nameBytes: Array.from(entry.nameBytes),
            metadata: Array.from(entry.metadata),
          },
          null,
          2,
        ),
      );
    const prefix = await source.read(0, Math.min(64, source.size));
    if (token !== generation) return;
    if (signature(prefix, 'BF_Movie_______\0')) {
      await showMovie(source, token);
      if (token === generation) status.textContent = 'BF_Movie ready.';
      return;
    }
    const request = workerClient(),
      result = await request<AssetInspection>({type: 'inspect', source: descriptor(source), name});
    if (token !== generation) return;
    viewer.append(
      node(
        'p',
        `${result.kind} · ${result.wrappers.join(' → ') || 'unwrapped'} · ${result.bytes.length.toLocaleString()} decoded bytes`,
      ),
    );
    const exports = node('div');
    exports.className = 'exports';
    exports.append(download(result.bytes, `${name}.${result.extension}`, result.mime));
    viewer.append(exports);
    details('Metadata', JSON.stringify(result.metadata, null, 2));
    if (result.image) showImage(result);
    else if (result.mime?.startsWith('audio/') || result.mime?.startsWith('video/')) {
      const media = result.mime.startsWith('audio/') ? node('audio') : node('video'),
        url = URL.createObjectURL(new Blob([result.bytes.slice().buffer], {type: result.mime}));
      media.controls = true;
      media.preload = 'metadata';
      media.src = url;
      media.onerror = () => {
        if (token === generation)
          report(
            'The browser could not play this codec. The decoded file is available for export.',
          );
      };
      cleanup.push(() => {
        media.pause();
        media.removeAttribute('src');
        media.load();
        URL.revokeObjectURL(url);
      });
      viewer.append(media);
    } else if (result.mime?.startsWith('font/')) {
      const font = new FontFace(`BurikoPreview${token}`, result.bytes.slice().buffer);
      await font.load();
      if (token !== generation) return;
      document.fonts.add(font);
      cleanup.push(() => document.fonts.delete(font));
      const sample = node('div', 'BGI / Ethornell\nあいうえお アイウエオ ABCDEFG 0123456789');
      sample.className = 'font-sample';
      sample.contentEditable = 'true';
      sample.style.fontFamily = `"${font.family}"`;
      sample.setAttribute('aria-label', 'Editable font sample');
      viewer.append(sample);
    }
    byteInspector(result.bytes);
    status.textContent = `Ready · ${name}`;
  } catch (error) {
    if (token === generation) {
      report(error);
      viewer.append(
        node('p', `Unable to decode: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
}
function render(): void {
  clear();
  list.replaceChildren();
  const mount = mounts[Number(select.value)];
  if (!mount) return;
  const query = filter.value.toLowerCase(),
    entries = mount.archive
      ? mount.archive.entries.filter((e) => `${e.index} ${e.name}`.toLowerCase().includes(query))
      : [{index: 0, name: mount.name}].filter((e) => e.name.toLowerCase().includes(query));
  page = Math.max(0, Math.min(page, Math.ceil(entries.length / 300) - 1));
  el('count').textContent =
    `${entries.length.toLocaleString()} entries · page ${page + 1} / ${Math.max(1, Math.ceil(entries.length / 300))}`;
  el<HTMLButtonElement>('previous').disabled = page === 0;
  el<HTMLButtonElement>('next').disabled = (page + 1) * 300 >= entries.length;
  for (const entry of entries.slice(page * 300, (page + 1) * 300)) {
    const b = button(`${entry.index.toString().padStart(4, '0')} · ${entry.name}`, () => {
      for (const other of list.children) other.setAttribute('aria-pressed', String(other === b));
      void preview(mount, entry.index);
    });
    b.setAttribute('aria-pressed', 'false');
    list.append(b);
  }
}
async function mountSources(files: {name: string; source: ByteSource}[]): Promise<void> {
  const own = ++loadGeneration;
  clear();
  mounts.length = 0;
  select.replaceChildren();
  list.replaceChildren();
  let failures = 0;
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const archive = file.name.toLowerCase().endsWith('.arc')
        ? await Arc20Archive.open(file.source)
        : undefined;
      if (own !== loadGeneration) return;
      mounts.push({...file, archive});
      select.add(new Option(file.name, String(mounts.length - 1)));
      status.textContent = `Indexed ${mounts.length} files…`;
    } catch (error) {
      if (own !== loadGeneration) return;
      failures++;
      report(error);
    }
  }
  if (own !== loadGeneration) return;
  page = 0;
  render();
  status.textContent = `${mounts.length} files · ${mounts.reduce((n, m) => n + (m.archive?.entries.length ?? 1), 0).toLocaleString()} entries${failures ? ` · ${failures} files failed to index` : ''}`;
}
select.onchange = () => {
  page = 0;
  render();
};
filter.oninput = () => {
  page = 0;
  render();
};
el('previous').onclick = () => {
  page--;
  render();
};
el('next').onclick = () => {
  page++;
  render();
};
el<HTMLInputElement>('files').onchange = (event) => {
  const files = Array.from((event.target as HTMLInputElement).files ?? []).filter(
    (file) => /\.arc$/i.test(file.name) || file.name === 'BGI.gdb',
  );
  void mountSources(
    files.map((file) => ({
      name: file.webkitRelativePath || file.name,
      source: new BlobSource(file),
    })),
  );
};
window.addEventListener('pagehide', () => clear());
