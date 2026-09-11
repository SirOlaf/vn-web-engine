import {readFile} from './filesystem.js';
import type {PlatformServices} from './services.js';
import type {RegistryHive, RegistryKey} from './registry.js';

/** Application UI over the same injected services the engine will receive. */
export function mountStoragePanel(parent: HTMLElement, platform: PlatformServices): () => void {
  let disposed = false,
    revision = 0,
    selectedFile: string | undefined;
  const section = document.createElement('section');
  section.className = 'storage-panel';
  const title = document.createElement('h2');
  title.textContent = 'Browser user data';
  const description = document.createElement('p');
  description.textContent =
    'Persistent files and virtual registry for this game/profile. Native save and settings formats are still being researched. This editor accesses browser storage directly.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  function field(label: string, value: string): HTMLInputElement {
    const wrapper = document.createElement('label'),
      input = document.createElement('input');
    input.value = value;
    wrapper.append(label, input);
    section.append(wrapper);
    return input;
  }
  function area(label: string): HTMLTextAreaElement {
    const wrapper = document.createElement('label'),
      input = document.createElement('textarea');
    input.rows = 8;
    wrapper.append(label, input);
    section.append(wrapper);
    return input;
  }
  function button(text: string, action: () => Promise<void>): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    section.append(b);
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action();
      } catch (error) {
        if (!disposed) status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  }
  section.append(title, description, status);
  const path = field('User file path', '/user/notes.txt'),
    contents = area('UTF-8 file contents');
  const files = document.createElement('div');
  section.append(files);
  async function refreshFiles(): Promise<void> {
    const token = ++revision;
    const paths: string[] = [];
    async function visit(path: string): Promise<void> {
      for (const entry of await platform.files.list(path)) {
        if (entry.kind === 'directory') await visit(entry.path);
        else paths.push(entry.path);
      }
    }
    await visit('/user');
    if (disposed || token !== revision) return;
    files.replaceChildren();
    if (!paths.length) files.textContent = 'No user files yet.';
    for (const p of paths) {
      const b = document.createElement('button');
      b.textContent = p;
      b.onclick = async () => {
        path.value = p;
        selectedFile = p;
        try {
          const bytes = await readFile(platform.files, p, 1024 * 1024);
          const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
          if (disposed || selectedFile !== p) return;
          contents.value = text;
          status.textContent = `${p} loaded (${bytes.length} bytes).`;
        } catch (error) {
          if (!disposed && selectedFile === p) {
            contents.value = '';
            status.textContent = `Cannot edit as UTF-8: ${error instanceof Error ? error.message : error}. Use export for binary files.`;
          }
        }
      };
      files.append(b);
    }
  }
  function userPath(): string {
    if (!path.value.startsWith('/user/'))
      throw new Error('The user-data editor only writes /user files');
    return path.value;
  }
  button('Save text file', async () => {
    const p = userPath();
    await platform.files.commit([
      {kind: 'write', path: p, data: new TextEncoder().encode(contents.value)},
    ]);
    await refreshFiles();
    status.textContent = `${p} saved in browser storage.`;
  });
  button('Delete file', async () => {
    const p = userPath();
    await platform.files.commit([{kind: 'delete', path: p}]);
    await refreshFiles();
    status.textContent = `${p} deleted.`;
  });
  button('Export file', async () => {
    const p = userPath(),
      source = await platform.files.open(p);
    const bytes = await source.read(0, source.size),
      url = URL.createObjectURL(new Blob([bytes.slice().buffer]));
    const a = document.createElement('a');
    a.href = url;
    a.download = p.split('/').at(-1)!;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  const importLabel = document.createElement('label'),
    imported = document.createElement('input');
  imported.type = 'file';
  importLabel.append('Import bytes to user file path', imported);
  section.append(importLabel);
  imported.onchange = async () => {
    try {
      const file = imported.files?.[0];
      if (!file) return;
      if (file.size > 64 * 1024 * 1024) throw new Error('Import exceeds 64 MiB');
      const p = userPath(),
        data = new Uint8Array(await file.arrayBuffer());
      await platform.files.commit([{kind: 'write', path: p, data}]);
      await refreshFiles();
      status.textContent = `${p} imported.`;
    } catch (error) {
      if (!disposed) status.textContent = String(error);
    }
  };
  const registryTitle = document.createElement('h3');
  registryTitle.textContent = 'Virtual registry';
  section.append(registryTitle);
  const hive = field('Registry hive', 'HKCU'),
    view = field('Registry view', '32'),
    keyPath = field('Registry key', 'Software\\VNRuntime');
  const name = field('Registry value name (empty is default)', ''),
    type = field('Registry numeric type', '3'),
    hex = area('Registry bytes (hex)');
  const values = document.createElement('div');
  section.append(values);
  function key(): RegistryKey {
    return {hive: hive.value as RegistryHive, view: view.value as '32' | '64', path: keyPath.value};
  }
  async function refreshRegistry(): Promise<void> {
    const result = await platform.registry.enumerate(key());
    if (disposed) return;
    values.replaceChildren();
    for (const subkey of result.subkeys) {
      const row = document.createElement('p');
      row.textContent = `Key: ${subkey}`;
      values.append(row);
    }
    for (const value of result.values) {
      const b = document.createElement('button');
      b.textContent = `${value.name || '(default)'} · type ${value.type} · ${value.data.length} bytes`;
      b.onclick = () => {
        name.value = value.name;
        type.value = String(value.type);
        hex.value = Array.from(value.data, (b) => b.toString(16).padStart(2, '0')).join(' ');
      };
      values.append(b);
    }
    status.textContent = `${result.subkeys.length} subkeys, ${result.values.length} values.`;
  }
  button('Read registry key', refreshRegistry);
  button('Create registry key', async () => {
    await platform.registry.createKey(key());
    await refreshRegistry();
  });
  button('Save registry value', async () => {
    const raw = hex.value.replace(/\s/g, '');
    if (!/^(?:[\da-fA-F]{2})*$/.test(raw)) throw new Error('Expected complete hex byte pairs');
    if (!/^\d+$/.test(type.value)) throw new Error('Expected a numeric registry type');
    await platform.registry.setValue(key(), name.value, {
      type: Number(type.value),
      data: Uint8Array.from(raw.match(/../g) ?? [], (s) => parseInt(s, 16)),
    });
    await refreshRegistry();
  });
  button('Delete registry value', async () => {
    await platform.registry.deleteValue(key(), name.value);
    await refreshRegistry();
  });
  button('Delete registry key', async () => {
    await platform.registry.deleteKey(key());
    values.replaceChildren();
    status.textContent = 'Registry key deleted.';
  });
  parent.append(section);
  void refreshFiles().catch((error) => {
    if (!disposed) status.textContent = String(error);
  });
  return () => {
    disposed = true;
    revision++;
    section.remove();
  };
}
