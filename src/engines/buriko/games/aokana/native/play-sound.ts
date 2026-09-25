import type {WindowsPlaySoundHost} from '../../../../../platform/windows-sound.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** F5DD0 joins the current native wide root with the decoded name and forwards WinMM's BOOL. */
export class AokanaPlaySound {
  constructor(
    readonly resources: AokanaProgramResources,
    readonly host: WindowsPlaySoundHost,
  ) {}

  play(filename: AokanaBpPointer | null): number {
    if (filename === null) throw new Error('Aokana PlaySoundW dereferences a null filename');
    const path =
      this.resources.configuration.nativeFileRoot + this.resources.files.text.decodeAuto(filename);
    if (path.length >= 788)
      throw new RangeError('Aokana PlaySoundW path exceeds native wide scratch');
    return this.host.playSoundW(path, this.host.executableModule, 0x22003) >>> 0;
  }
}

/** E4FF0 consumes one BP address and pushes PlaySoundW's immediate EAX. */
export function createGroupA0PlaySound(sound: AokanaPlaySound): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0xc0,
      nativeAddress: 0x1400e4ff0,
      name: 'PlaySoundFilename',
      execute: (context): 0 => {
        const filename = context.memory.resolve(context.thread, pop32(context.thread));
        push32(context.thread, sound.play(filename));
        return 0;
      },
    },
  ];
}
