/** Selected browser output profile; these are host primitives, not A0 declarations. */
export interface BurikoAudioBufferFormat {
  sampleRate: number;
  channels: number;
  bits: 8 | 16 | 24;
  byteLength: number;
}
export type BurikoAudioBufferCommand =
  | {kind: 'write'; offset: number; bytes: Uint8Array; initialized: Uint8Array}
  | {kind: 'notifications'; offsets: readonly number[]}
  | {kind: 'play'; loop: boolean}
  | {kind: 'stop'}
  | {kind: 'seek'; byteOffset: number}
  | {kind: 'volume'; decibels: number}
  | {kind: 'pan'; decibels: number}
  | {kind: 'status'}
  | {kind: 'dispose'};
export interface BurikoAudioBufferStatus {
  playing: boolean;
  byteCursor: number;
  /** Render frames processed by this buffer, including stopped output. */
  renderFrame: number;
}
export interface BurikoAudioBufferNotification {
  index: number;
  offset: number;
  renderFrame: number;
}
export interface BurikoAudioBufferRequest {
  id: number;
  command: BurikoAudioBufferCommand;
}
export type BurikoAudioBufferResponse =
  | {kind: 'reply'; id: number; status: BurikoAudioBufferStatus}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'events'; events: BurikoAudioBufferNotification[]}
  | {kind: 'failure'; message: string};
