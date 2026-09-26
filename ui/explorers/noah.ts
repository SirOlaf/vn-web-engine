import {openNoahPlayer} from '../../src/engines/mages/games/chaos-head-noah/sc3/browser-player.js';
import {BlobSource} from '../../src/core/source.js';
import {CpkArchive} from '../../src/formats/cri/cpk.js';
import {mountCharacterPlayer} from './character-player.js';
import {mountMoviePlayer} from './movie-player.js';
import {mountAudioPlayer} from './audio-player.js';
import type {AudioSource} from '../../src/audio/worker-protocol.js';
import {identifyAsset} from '../../src/engines/mages/assets.js';
import {SourceFileSystem} from '../../src/platform/filesystem.js';
import {openBrowserPlatform} from '../../src/platform/services.js';
import {mountStoragePanel} from './storage-panel.js';
import {windowsFileKey} from '../../src/platform/windows-filesystem.js';
import {NOAH_WINDOWS} from '../../src/engines/mages/games/chaos-head-noah/paths.js';
import {gameDirectoryFiles} from '../../src/game-directory.js';
function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing ${id}`);
  return el as T;
}
const select = element<HTMLSelectElement>('archives'),
  list = element('entries'),
  viewer = element('viewer'),
  status = element('status'),
  filter = element<HTMLInputElement>('filter');
const archives = new Map<string, CpkArchive>();
let generation = 0,
  url: string | undefined;
let disposePreview: (() => void) | undefined;
const gameFiles = new SourceFileSystem(windowsFileKey);
let platform: ReturnType<typeof openBrowserPlatform> | undefined;
element<HTMLButtonElement>('vm-boot').onclick = async () => {
  clearPreview();
  const token = generation;
  status.textContent = 'Opening live game…';
  try {
    const lookup = (name: string) => [...archives].find(([key]) => key.toLowerCase() === name)?.[1];
    const scripts = lookup('script.cpk'),
      messages = lookup('mes00.cpk');
    if (!scripts || !messages)
      throw new Error('Choose script.cpk, mes00.cpk and Game.exe in the game folder first.');
    try {
      await gameFiles.stat('/Game.exe');
    } catch {
      throw new Error('Choose the installed Game.exe to load its original cursors.');
    }
    const services = await (platform ??= openBrowserPlatform(
      'chaos-head-noah-gog',
      'default',
      gameFiles,
      NOAH_WINDOWS,
    ).catch((error) => {
      platform = undefined;
      throw error;
    }));
    if (token !== generation) return;
    const result = await openNoahPlayer(services, lookup, report);
    if (token !== generation) {
      result.dispose();
      return;
    }
    disposePreview = () => {
      result.dispose();
    };
    viewer.append(result.panel);
    status.textContent = 'Live game ready. Use Start / restart and Fast-forward below.';
  } catch (error) {
    if (token === generation) {
      disposePreview?.();
      disposePreview = undefined;
      report(error);
    }
  }
};
element<HTMLButtonElement>('storage').onclick = async () => {
  clearPreview();
  const token = generation;
  try {
    const services = await (platform ??= openBrowserPlatform(
      'chaos-head-noah-gog',
      'default',
      gameFiles,
      NOAH_WINDOWS,
    ).catch((error) => {
      platform = undefined;
      throw error;
    }));
    if (token !== generation) return;
    disposePreview = mountStoragePanel(viewer, services);
    status.textContent = 'Browser user data · default profile';
  } catch (error) {
    if (token === generation) report(error);
  }
};
function report(error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}
function clearPreview(): void {
  generation++;
  disposePreview?.();
  disposePreview = undefined;
  if (url) {
    URL.revokeObjectURL(url);
    url = undefined;
  }
  viewer.replaceChildren();
}
function add(name: string, archive: CpkArchive): void {
  archives.set(name, archive);
  if (!Array.from(select.options).some((o) => o.value === name)) select.add(new Option(name, name));
}
function render(): void {
  clearPreview();
  list.replaceChildren();
  const archive = archives.get(select.value);
  if (!archive) return;
  const query = filter.value.toLowerCase(),
    entries = archive.entries.filter((e) =>
      `${e.id} ${e.name ?? ''}`.toLowerCase().includes(query),
    );
  element('count').textContent =
    `${entries.length.toLocaleString()} assets · showing ${Math.min(300, entries.length)}`;
  for (const entry of entries.slice(0, 300)) {
    const button = document.createElement('button');
    button.textContent = `${String(entry.id).padStart(4, '0')} · ${entry.name ?? `${(entry.size / 1024).toFixed(1)} KB`}`;
    button.setAttribute('aria-pressed', 'false');
    button.onclick = async () => {
      clearPreview();
      const token = generation;
      for (const other of list.children)
        other.setAttribute('aria-pressed', String(other === button));
      status.textContent = `Reading ${select.value} / ${entry.id}…`;
      try {
        // Media workers stream bounded archive ranges; the inspector only reads a prefix.
        const prefix = await archive.readStoredRange(entry.id, 0, Math.min(32, entry.storedSize));
        const extension = identifyAsset(prefix).extension,
          isAudio = extension === 'hca',
          isMovie = extension === 'usm';
        const prefixOnly = isAudio || isMovie || entry.size > 32 * 1024 * 1024;
        const bytes = prefixOnly
          ? await archive.readStoredRange(entry.id, 0, Math.min(256, entry.storedSize))
          : await archive.read(entry.id);
        if (token !== generation) return;
        const kind = identifyAsset(bytes),
          heading = document.createElement('h2');
        heading.textContent = `${select.value} / ${entry.id}`;
        const details = document.createElement('p');
        details.className = 'details';
        details.textContent = `${kind.name} · ${entry.size.toLocaleString()} bytes · stored ${entry.storedSize.toLocaleString()} · offset 0x${entry.offset.toString(16)}`;
        viewer.append(heading, details);
        const isCharacter = /^chara(?:_dlc)?\.cpk$/.test(select.value);
        if (isCharacter) {
          const atlasId = entry.id - (entry.id % 2),
            geometryId = atlasId + 1;
          const atlas = entry.id === atlasId ? bytes : await archive.read(atlasId);
          const geometry = entry.id === geometryId ? bytes : await archive.read(geometryId);
          if (token !== generation) return;
          const dispose = await mountCharacterPlayer(viewer, geometry, atlas);
          if (token !== generation) {
            dispose();
            return;
          }
          disposePreview = dispose;
        }
        if (isAudio || isMovie) {
          const source = archive.source;
          let descriptor: AudioSource;
          if (source instanceof BlobSource)
            descriptor = {
              kind: 'blob',
              blob: source.blob.slice(entry.offset, entry.offset + entry.storedSize),
            };
          else throw new Error('This source cannot be transferred to an audio worker');
          disposePreview = isMovie
            ? mountMoviePlayer(viewer, descriptor)
            : mountAudioPlayer(
                viewer,
                descriptor,
                `${select.value.replace(/\.cpk$/, '')}-${entry.id}`,
              );
        }
        if (!prefixOnly) {
          url = URL.createObjectURL(
            new Blob([bytes.slice().buffer], {type: kind.mime ?? 'application/octet-stream'}),
          );
          const link = document.createElement('a');
          link.href = url;
          link.download = `${select.value.replace(/\.cpk$/, '')}-${entry.id}.${kind.extension}`;
          link.textContent = 'Save decoded asset';
          viewer.append(link);
          if (!isCharacter && kind.mime?.startsWith('image/')) {
            const img = document.createElement('img');
            img.alt = `${select.value} asset ${entry.id}`;
            img.src = url;
            img.onerror = () => {
              if (token === generation)
                status.textContent = 'Browser image decoder rejected this asset';
            };
            viewer.append(img);
          }
        }
        const pre = document.createElement('pre');
        const lines = [];
        for (let p = 0; p < Math.min(bytes.length, 256); p += 16) {
          const chunk = bytes.subarray(p, p + 16);
          lines.push(
            `${p.toString(16).padStart(6, '0')}  ${Array.from(chunk, (b) =>
              b.toString(16).padStart(2, '0'),
            )
              .join(' ')
              .padEnd(
                47,
              )}  ${Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`,
          );
        }
        pre.textContent = lines.join('\n');
        viewer.append(pre);
        status.textContent = isCharacter
          ? 'Character assembled. Choose expression, mouth and eyes.'
          : isMovie
            ? 'Movie ready to play.'
            : isAudio
              ? 'Audio ready to decode.'
              : prefixOnly
                ? 'Large media: showing stored prefix only.'
                : 'Asset loaded.';
      } catch (error) {
        if (token === generation) report(error);
      }
    };
    list.append(button);
  }
}
select.onchange = render;
filter.oninput = render;
element<HTMLInputElement>('files').onchange = async (event) => {
  try {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const selectedFiles = Array.from(input.files);
    input.value = '';
    const selected = gameDirectoryFiles(selectedFiles);
    archives.clear();
    gameFiles.clear();
    select.replaceChildren();
    gameFiles.attach('/Game.exe', new BlobSource(selected.executable));
    for (const file of selected.archives) {
      const path = '/Data/' + file.name;
      gameFiles.attach(path, new BlobSource(file));
      add(file.name, await CpkArchive.open(await gameFiles.open(path)));
    }
    render();
    status.textContent = `${archives.size} archives indexed from this device.`;
  } catch (error) {
    report(error);
  }
};
