/** Read-only installation helper shared by nonvisual Artemis tools. */
import {readdir, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openSource} from './file-source.mjs';
import {ArtemisFiles} from '../dist/engines/artemis/files.js';

export async function openArtemisInstallation(directory) {
  const root = resolve(directory),
    names = await readdir(root);
  const bases = names.filter((n) => !n.startsWith('._') && n.endsWith('.pfs'));
  if (bases.length !== 1) throw new Error('Expected exactly one base .pfs archive');
  const sources = new Map();
  async function close() {
    for (const source of sources.values()) await source.close();
  }
  async function lookup(parts) {
    const path = parts.join('/');
    if (sources.has(path)) return sources.get(path);
    try {
      const target = resolve(root, ...parts);
      if (!(await stat(target)).isFile()) return undefined;
      const source = await openSource(target);
      sources.set(path, source);
      return source;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }
  try {
    const files = await ArtemisFiles.mount(bases[0], lookup);
    const paths = new Set();
    for (const {archive} of files.archives)
      for (const entry of archive.entries) paths.add(entry.name.replaceAll('\\', '/'));
    // Inventory names only. Images/audio/video are never read here.
    async function inventory(parts) {
      for (const entry of await readdir(resolve(root, ...parts), {withFileTypes: true})) {
        if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
        const path = [...parts, entry.name];
        if (entry.isDirectory()) await inventory(path);
        else if (entry.isFile()) paths.add(path.join('/'));
      }
    }
    await inventory([]);
    return {files, paths, close};
  } catch (error) {
    await close();
    throw error;
  }
}
