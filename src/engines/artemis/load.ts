import type {AsbTag} from '../../formats/artemis/asb.js';
import {ArtemisSaveArchiveReader, unpackArtemisSaveFile} from '../../formats/artemis/save-file.js';
import type {ArtemisEvents} from './events.js';
import {readArtemisSaveArchive, type ArtemisReadHistory} from './global-save.js';
import type {ArtemisSave} from './save.js';
import type {ArtemisVariables} from './variables.js';

export interface ArtemisLoadHost {
  /** CArtemisPackFile open of the name relative to `SaveDataPath`; null when it fails. */
  readSaveFile(name: string): Promise<Uint8Array | null>;
  /** Loader 0x140141b10 for a kind 'S' archive. */
  loadScenario(archive: ArtemisSaveArchiveReader): Promise<void>;
  /** c7020 severity 1 with "[Lua] onLoad %s: %s" (handler name, Lua error). */
  reportEventError(handler: string, error: unknown): void;
  /** Lua call of the `onLoad` handler; resolves once the callback and any resource work it
   * started have finished. */
  callEvent(name: string, args: ReadonlyMap<string, string>): Promise<void>;
  /** Trans tag 0x1400e10c0 with the load tag's arguments (passed as a `trans` tag). */
  transition(tag: AsbTag): boolean | Promise<void>;
}

/** Save-file reader 0x14013fde0 and the load tag 0x1400ca740. */
export class ArtemisLoad {
  constructor(
    private readonly save: ArtemisSave,
    private readonly history: ArtemisReadHistory,
    private readonly variables: ArtemisVariables,
    private readonly events: ArtemisEvents,
    private readonly host: ArtemisLoadHost,
  ) {}
  /** 0x14013fde0. `forceGlobal` first runs the save gate with an empty name and a forced
   * global save. Unreadable files, unknown headers and versions outside 1000..1099 fail
   * (false) without changing state. Kind G and X archives restore the read history and
   * variables, S runs the scenario loader, other kinds are read and ignored. Then the
   * `onLoad` handler, when set, receives {"file": name}; a Lua error is reported and
   * clears the handler. */
  async load(file: string, forceGlobal: boolean): Promise<boolean> {
    if (forceGlobal) this.save.request('', false, true);
    const bytes = await this.host.readSaveFile(file);
    if (bytes === null) return false;
    const saved = await unpackArtemisSaveFile(bytes);
    if (!saved) return false;
    if (saved.kind === 'S')
      await this.host.loadScenario(new ArtemisSaveArchiveReader(saved.archive));
    else readArtemisSaveArchive(saved, this.history, this.variables);
    const handler = this.events.handler('onLoad');
    if (handler)
      try {
        await this.events.emitAsync('onLoad', new Map([['file', file]]), (name, args) =>
          this.host.callEvent(name, args),
        );
      } catch (error) {
        // `emit` has cleared the handler, as 0x14013fde0 does after the report.
        this.host.reportEventError(handler, error);
      }
    return true;
  }
  /** Load tag: `file` (absent reads as empty) with a forced global save; a successful load
   * whose tag has `type` continues as the trans tag. */
  async dispatch(tag: AsbTag): Promise<boolean> {
    if (tag.name !== 'load') return false;
    if ((await this.load(tag.args.get('file') ?? '', true)) && tag.args.has('type'))
      await this.host.transition({...tag, name: 'trans'});
    return true;
  }
}
