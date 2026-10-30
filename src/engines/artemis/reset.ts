import type {AsbTag} from '../../formats/artemis/asb.js';
import {unpackArtemisSaveFile} from '../../formats/artemis/save-file.js';
import {readArtemisSaveArchive, type ArtemisReadHistory} from './global-save.js';
import type {ArtemisModes} from './modes.js';
import {artemisInteger} from './numbers.js';
import type {ArtemisSave} from './save.js';
import type {ArtemisVariables} from './variables.js';

export interface ArtemisResetHost {
  /** ini.Boot from the dynamic INI variables; an absent key reads as empty. */
  bootPath(): string;
  /** 0x1400b6cf0: releases a placed click glyph. */
  updateMessageState(): void;
  /** Scheduler virtual +0x30(0). */
  releaseScheduler(): void;
  /** The bf210 owner fields after the mode bytes, in native order: exec requests and
   * script event queues, debug mode/level from ini.DebugMode/DebugLevel, message selection,
   * font frames, indicator/scene-tween maps, ruby, text controls, transition tween
   * (finished, a54b0) and transition object, cursor shown, key push maps, seton* slots,
   * new music/effect managers (all sound stopped, effect id map cleared), Lua event names,
   * scene root replacement, message-layer store ("backlog" then "" created, "" selected). */
  resetOwners(): void;
  /** c4680: s.bgmvol / s.sevol to the music and effect managers. Per-id s.segain.* gains
   * apply only to ids in the effect map, which reset has emptied. */
  applyVolumes(music: number, effect: number): void;
  /** Save-object (+0xd0) command histories and registries. */
  resetSaveObject(): void;
  /** c4ad0 through the script cache, restarting the caret at the boot file. */
  loadBoot(path: string): void;
  /** Boot only: saveg.dat / system.dat bytes, or null when absent. */
  readSaveFile?(name: 'saveg.dat' | 'system.dat'): Promise<Uint8Array | null>;
  /** Boot only: c37e0 static engine variables (s.engineversion, s.status.*, ...). */
  initializeStaticVariables?(): void;
}

/** Native reset tag 0x1400caad0 and the engine reset 0x1400bf210 (flag 1 for the tag,
 * flag 0 for application boot). */
export class ArtemisReset {
  constructor(
    private readonly modes: ArtemisModes,
    private readonly save: ArtemisSave,
    private readonly variables: ArtemisVariables,
    private readonly history: ArtemisReadHistory,
    private readonly host: ArtemisResetHost,
  ) {}
  private begin(): string {
    const boot = this.host.bootPath();
    this.host.updateMessageState();
    this.modes.setAutomode(false);
    this.host.releaseScheduler();
    this.modes.reset();
    this.host.resetOwners();
    return boot;
  }
  private volume(name: string): number {
    // Variables virtual +0x10: integer read; an absent name reads as zero.
    const value = this.variables.lookup(name);
    return value === undefined ? 0 : artemisInteger(new TextDecoder().decode(value));
  }
  private finish(boot: string): void {
    this.host.applyVolumes(this.volume('s.bgmvol'), this.volume('s.sevol'));
    this.host.resetSaveObject();
    this.host.loadBoot(boot);
  }
  /** 0x14013fde0: unreadable or unknown files fail without changing state. */
  private async load(name: 'saveg.dat' | 'system.dat'): Promise<void> {
    const bytes = await this.host.readSaveFile!(name);
    if (bytes === null) return;
    const file = await unpackArtemisSaveFile(bytes);
    if (file) readArtemisSaveArchive(file, this.history, this.variables);
  }
  /** bf210(flag 0): default volumes, saveg.dat and system.dat, then c37e0 statics. */
  async boot(): Promise<void> {
    if (!this.host.readSaveFile || !this.host.initializeStaticVariables)
      throw Error('Artemis boot requires save-file and static-variable owners');
    const boot = this.begin();
    for (const name of ['s.bgmvol', 's.sevol', 's.videovol', 's.automodewait'])
      this.variables.write(name, '1000');
    await this.load('saveg.dat');
    await this.load('system.dat');
    this.host.initializeStaticVariables();
    this.finish(boot);
  }
  /** bf210 with flag 1, as the reset tag and scenario loader 0x140141b10 call it. */
  engineReset(): void {
    this.finish(this.begin());
  }
  /** caad0: forced global save, bf210(flag 1), then every variable except g./s. erased. */
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'reset') return false;
    this.save.request('', false, true);
    this.engineReset();
    this.variables.resetScenario();
    return true;
  }
}
