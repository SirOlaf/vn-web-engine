import type {BurikoBpPointer} from '../../bp/memory.js';

/** Actual CStorageModel inputs. Each operation receives its current execution actor. */
export interface BurikoLiveAudioStorage {
  readonly size: number;
  readonly position: number;
  readonly flags: number;
  readInto(
    destination: BurikoBpPointer,
    count: number,
    actor: object,
    initialized?: Uint8Array,
  ): Promise<number>;
  seek(position: number, actor?: object): number | Promise<number>;
  dispose(): void | Promise<void>;
}
