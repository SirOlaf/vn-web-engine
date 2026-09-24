import type {AokanaProgramResources} from '../program-resources.js';
import {textBytes} from '../text.js';
import type {AokanaAudioResourceStreams} from './resource-streams.js';

/** NUL-terminated original encoded storage, observed at each consumption rather than wrapper entry. */
export type AokanaAudioResourceName = () => Uint8Array;
const literal = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!, (v) => parseInt(v, 16));
const missing = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573205d2082cd91b68ddd82b582dc82b982f100',
);
const missingArchive = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573203a202573205d2082cd91b68ddd82b582dc82b982f100',
);
export const aokanaMissingWaveDiagnostic = literal(
  '8e7792e882b382ea82bd4257837483408343838b205b202573205d2082cd91b68ddd82b582dc82b982f100',
);
export const aokanaInvalidWaveDiagnostic = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573205d2082cd4257837483408343838b82c582cd82c882a282e682a482c582b700',
);
/** Native sprintf byte substitution; caller owns the exact stack capacity. */
export function formatAokanaAudioNames(
  format: Uint8Array,
  names: readonly Uint8Array[],
  capacity: number,
): Uint8Array {
  const output: number[] = [];
  let next = 0;
  for (let index = 0; index < format.length && format[index] !== 0; index++) {
    if (format[index] === 37 && format[index + 1] === 115) {
      const name = names[next++];
      if (name === undefined) throw new Error('Aokana audio diagnostic is missing native argument');
      for (const byte of textBytes({bytes: name, offset: 0})) {
        output.push(byte);
        if (output.length >= capacity)
          throw new RangeError('Aokana audio diagnostic exceeds native stack');
      }
      index++;
    } else output.push(format[index]!);
    if (output.length >= capacity)
      throw new RangeError('Aokana audio diagnostic exceeds native stack');
  }
  output.push(0);
  return Uint8Array.from(output);
}

/**F5910/F5070/F5A80: actual shared roots/media/archives/dialogs, without an async-job substitute. */
export class AokanaAudioMusicResources {
  constructor(
    readonly resources: AokanaProgramResources,
    readonly streams: AokanaAudioResourceStreams,
  ) {
    if (resources.files !== streams.files)
      throw new Error('Aokana music resources must share the actual mounted files');
  }
  private async engine<T>(actor: object, operation: () => Promise<T>): Promise<T> {
    return this.streams.channels.withEngineControl(operation, actor);
  }
  private wide(bytes: Uint8Array): string {
    return this.resources.files.text.decodeAuto({bytes, offset: 0});
  }
  private async stop(index: number, actor: object): Promise<void> {
    await this.engine(actor, async () => {
      await this.streams.channels.stopStream(index, actor);
    });
  }
  /**F5910: one primary attempt, then only result12 can admit one secondary-media attempt. */
  async loadSimple(
    index: number,
    name: AokanaAudioResourceName,
    volume: number,
    actor = this.streams.channels.actors.currentActor,
  ): Promise<number> {
    await this.stop(index, actor);
    const config = this.resources.configuration;
    let path = this.wide(this.resources.loosePath(config.primaryRoot, name()));
    let status = await this.engine(actor, () =>
      this.streams.loadLoose(index, path, volume, 64, 1, actor),
    );
    if (status === 12 && this.resources.files.media.isAvailable(config.secondaryMediaPath)) {
      path = this.wide(this.resources.loosePath(config.secondaryRoot, name()));
      status = await this.engine(actor, () =>
        this.streams.loadLoose(index, path, volume, 64, 1, actor),
      );
    }
    return status;
  }
  private media(root: Uint8Array): boolean {
    const wide = this.wide(root);
    if (wide.length >= 788)
      throw new RangeError('Aokana music media path exceeds native wide stack');
    return this.resources.files.media.isAvailable(wide);
  }
  /**F5070: initial media gates the whole directory traversal. */
  private search(
    index: number,
    root: AokanaAudioResourceName,
    name: AokanaAudioResourceName,
    volume: number,
    pan: number,
    actor: object,
  ): Promise<number> {
    return this.engine(actor, async () => {
      if (!this.media(root())) return 12;
      let path = this.wide(this.resources.loosePath(root(), name()));
      let status = await this.streams.loadLoose(index, path, volume, pan, 1, actor);
      const config = this.resources.configuration;
      const directories = config.searchDirectoriesEnabled === 0 ? null : config.searchDirectories;
      if (directories !== null)
        for (const directory of directories) {
          if (status !== 12) break;
          if (this.media(root())) {
            const intermediate = this.resources.loosePath(root(), directory);
            path = this.wide(this.resources.loosePath(intermediate, name(), true));
            status = await this.streams.loadLoose(index, path, volume, pan, 1, actor);
          }
        }
      return status;
    });
  }
  /**F5A80: completed real music lower for the future shared worker and A0:11. */
  async loadMusic(
    index: number,
    archive: AokanaAudioResourceName | null,
    name: AokanaAudioResourceName,
    volume: number,
    pan: number,
    actor = this.streams.channels.actors.currentActor,
  ): Promise<number> {
    await this.stop(index, actor);
    const config = this.resources.configuration;
    let status = await this.search(index, () => config.primaryRoot, name, volume, pan, actor);
    if (status !== 12) return status;
    if (archive === null) {
      for (;;) {
        status = await this.search(index, () => config.secondaryRoot, name, volume, pan, actor);
        if (status !== 12) return status;
        await this.resources.requestMediaRetry(formatAokanaAudioNames(missing, [name()], 784));
      }
    }
    const member = this.wide(name());
    const attempt = async (root: Uint8Array): Promise<number> => {
      const combined = this.resources.loosePath(root, archive());
      const physical = await this.resources.archives.entryPath(combined, name());
      if (physical === null) return 12;
      const path = this.wide(physical);
      return this.engine(actor, () =>
        this.streams.loadArchive(index, path, member, volume, pan, 1, actor),
      );
    };
    status = await attempt(config.primaryRoot);
    if (status !== 12) return status;
    for (;;) {
      if (this.resources.files.media.isAvailable(config.secondaryMediaPath)) {
        status = await attempt(config.secondaryRoot);
        if (status !== 12) return status;
      }
      await this.resources.requestMediaRetry(
        formatAokanaAudioNames(missingArchive, [archive(), name()], 784),
      );
    }
  }
}
