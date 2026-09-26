import type {AokanaBpPointer} from '../../bp/memory.js';

/** Actual CStorageModel inputs. Each operation receives its current execution actor. */
export interface AokanaLiveAudioStorage {
  readonly size: number;
  readonly position: number;
  readonly flags: number;
  readInto(
    destination: AokanaBpPointer,
    count: number,
    actor: object,
    initialized?: Uint8Array,
  ): Promise<number>;
  seek(position: number, actor?: object): number | Promise<number>;
  dispose(): void | Promise<void>;
}
