import type {BurikoProgramFiles} from '../program-files.js';
import type {BurikoAudioChannels} from './channel-registry.js';
import {BurikoAudioArchiveTree} from './archive-cache-tree.js';
import {BurikoDcArchive, burikoAudioWideLower} from './dc-archive.js';

import {audioPathAbsolute, audioPathTerminated, appendAudioWidePath} from './wide-path.js';

export interface BurikoAudioArchiveResult {
  readonly status: number;
  readonly archive?: BurikoDcArchive;
}

/** Actual27CCD0 cache; caller owns the same27CC70 section across the full raw operation. */
export class BurikoAudioArchiveCache {
  readonly channels: BurikoAudioChannels;
  readonly files: BurikoProgramFiles;
  rootWide = ''; // distinct1CC538, not ProgramResources.primaryRoot
  fastLookup = 0; //27C718
  searchDirectories: readonly string[] | null = null; // distinct nullable27C710 vector
  private readonly tree = new BurikoAudioArchiveTree<BurikoDcArchive>();
  private disposed = false;
  constructor(channels: BurikoAudioChannels, files: BurikoProgramFiles) {
    this.channels = channels;
    this.files = files;
  }
  private requireAdmission(actor: object): void {
    if (this.disposed) throw new Error('Buriko audio archive cache accesses released owner');
    if (this.channels.section.owner !== actor)
      throw new Error('Buriko audio archive cache requires actual shared27CC70 admission');
  }
  /** 114E60/114C70 root getter recursively enters the same section. */
  private async readRoot(actor: object): Promise<string> {
    await this.channels.section.enter(actor);
    try {
      return audioPathTerminated(this.rootWide);
    } finally {
      this.channels.section.leave(actor);
    }
  }
  /**1128E0: same real root, optional ordered search vector, and actual mounted status. */
  async resolveLoosePath(path: string, actor: object): Promise<string> {
    this.requireAdmission(actor);
    path = audioPathTerminated(path);
    if (audioPathAbsolute(path)) return path;
    const root = await this.readRoot(actor);
    const initial = root + path;
    if (this.searchDirectories !== null && !(await this.files.hasPathWide(initial))) {
      for (const directory of this.searchDirectories) {
        const candidate = appendAudioWidePath(
          audioPathAbsolute(directory) ? directory : root + directory,
          path,
        );
        if (await this.files.hasPathWide(candidate)) return candidate;
      }
    }
    return initial;
  }
  /**1124B0: cached archive publication precedes member presence/refresh. */
  async find(path: string, member: string, actor: object): Promise<BurikoAudioArchiveResult> {
    this.requireAdmission(actor);
    path = audioPathTerminated(path);
    let archive = this.fastLookup !== 0 ? this.tree.find(path) : undefined;
    if (archive === undefined) {
      const relative = !audioPathAbsolute(path);
      const key = burikoAudioWideLower(relative ? (await this.readRoot(actor)) + path : path);
      archive = this.tree.find(key);
      if (archive === undefined) {
        let candidate: BurikoDcArchive | null = new BurikoDcArchive(this.files);
        try {
          if ((await candidate.openIndex(key, actor)) !== 0) return {status: 26};
          this.requireAdmission(actor);
          if (this.tree.replace(key, candidate, (old) => old.dispose())) archive = candidate;
          else archive = this.tree.insertOrKeep(key, candidate, (old) => old.dispose());
          candidate = null;
        } finally {
          candidate?.dispose();
        }
      }
    }
    const status = await archive.hasMember(audioPathTerminated(member), actor);
    return status === 0 ? {status: 0, archive} : {status: 25};
  }
  /**00D940 retains the actual sentinel for reuse. Not full112E90 audio shutdown. */
  clear(actor: object): void {
    this.requireAdmission(actor);
    this.tree.clear((archive) => archive.dispose());
  }
  dispose(actor: object): void {
    this.clear(actor);
    this.disposed = true;
  }
}
