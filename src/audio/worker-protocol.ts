import type {HcaHeader} from '../formats/cri/hca/header.js';
import type {PcmClip} from './pcm.js';
export type {WorkerSource as AudioSource} from '../core/worker-source.js';
import type {WorkerSource as AudioSource} from '../core/worker-source.js';
export type AudioRequest = {type: 'decode'; source: AudioSource};
export type AudioResponse =
  | {type: 'header'; header: HcaHeader}
  | {type: 'progress'; fraction: number}
  | {type: 'complete'; clip: PcmClip; elapsedMs: number}
  | {type: 'error'; message: string};
