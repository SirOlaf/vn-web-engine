import type {BurikoBpPointer} from '../../bp/memory.js';
import type {BurikoDcArchive} from './dc-archive.js';

/** 115DE0/115E70/115D10: member cursor owns its name, not the shared archive. */
export class BurikoArchiveFileStorage {
  private archive: BurikoDcArchive | undefined;
  private name = '';
  private sizeValue = 0;
  private positionValue: number | undefined;
  private disposed = false;
  readonly flags = 1;
  get size(): number {
    return this.sizeValue;
  }
  get position(): number {
    if (this.positionValue === undefined)
      throw new Error('Buriko archive storage reads unwritten cursor');
    return this.positionValue;
  }
  private check(): void {
    if (this.disposed) throw new Error('Buriko archive storage accesses released owner');
  }
  async open(archive: BurikoDcArchive, name: string, actor: object): Promise<boolean> {
    this.check();
    const info = await archive.memberInfo(name, actor);
    if (info.status !== 0) return false;
    this.sizeValue = info.size!;
    this.archive = archive;
    this.name = name;
    this.positionValue = 0;
    return true;
  }
  seek(position: number): number {
    this.check();
    this.positionValue = Math.min(position >>> 0, this.sizeValue);
    return this.positionValue;
  }
  async readInto(
    destination: BurikoBpPointer,
    count: number,
    actor: object,
    initialized?: Uint8Array,
  ): Promise<number> {
    this.check();
    count >>>= 0;
    const position = this.position;
    if (this.sizeValue < (position + count) >>> 0) count = (this.sizeValue - position) >>> 0;
    if (count !== 0) {
      if (this.archive === undefined)
        throw new Error('Buriko archive storage reads unwritten archive');
      const result = await this.archive.readMember(
        destination,
        this.name,
        position,
        count,
        actor,
        initialized,
      );
      if (result === 0) {
        this.positionValue = (this.position + count) >>> 0;
        return count;
      }
    }
    return 0;
  }
  dispose(): void {
    this.check();
    this.name = '';
    this.archive = undefined;
    this.disposed = true;
  }
}
