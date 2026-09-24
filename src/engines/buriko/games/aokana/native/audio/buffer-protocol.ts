/** Selected browser output profile; these are host primitives, not A0 declarations. */
export interface AokanaAudioBufferFormat {
  sampleRate: number;
  channels: number;
  bits: 8 | 16 | 24;
  byteLength: number;
}
export type AokanaAudioBufferCommand =
  | {kind: 'write'; offset: number; bytes: Uint8Array; initialized: Uint8Array}
  | {kind: 'notifications'; offsets: readonly number[]}
  | {kind: 'play'; loop: boolean}
  | {kind: 'stop'}
  | {kind: 'seek'; byteOffset: number}
  | {kind: 'volume'; decibels: number}
  | {kind: 'pan'; decibels: number}
  | {kind: 'status'}
  | {kind: 'dispose'};
export interface AokanaAudioBufferStatus {
  playing: boolean;
  byteCursor: number;
  /** Render frames processed by this buffer, including stopped output. */
  renderFrame: number;
}
export interface AokanaAudioBufferNotification {
  index: number;
  offset: number;
  renderFrame: number;
}
export interface AokanaAudioBufferRequest {
  id: number;
  command: AokanaAudioBufferCommand;
}
export type AokanaAudioBufferResponse =
  | {kind: 'reply'; id: number; status: AokanaAudioBufferStatus}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'events'; events: AokanaAudioBufferNotification[]}
  | {kind: 'failure'; message: string};
