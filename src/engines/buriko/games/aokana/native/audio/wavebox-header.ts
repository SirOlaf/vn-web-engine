export class AokanaWaveBoxError extends Error {
  constructor(
    readonly nativeCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AokanaWaveBoxError';
  }
}

export interface AokanaWaveBoxCheckpoint {
  readonly predictor: number;
  readonly step: number;
}

export interface AokanaWaveBoxHeader {
  readonly raw: Uint8Array;
  readonly resetDataOffset: number;
  readonly field08: number;
  readonly sourceFrameCount: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly loopEnabled: number;
  readonly loopStartFrame: number;
  readonly loopLeft: AokanaWaveBoxCheckpoint;
  readonly loopRight: AokanaWaveBoxCheckpoint;
  readonly codec: 0 | 1 | 2 | 3;
  readonly field34: number;
  readonly huffmanLoopBitOffset: number;
  readonly hfAdpcmShiftParameter: number;
}

/** Selector 1401140a0 precedes common initialization 140118940, including error precedence. */
export function parseAokanaWaveBoxHeader(bytes: Uint8Array): AokanaWaveBoxHeader {
  if (bytes.length < 64)
    throw new AokanaWaveBoxError(0x0e, 'Aokana WaveBox header is shorter than 64 bytes');
  const raw = bytes.slice(0, 64),
    view = new DataView(raw.buffer);
  const word = (offset: number) => view.getUint32(offset, true);
  const codec = word(0x30);
  if (codec !== 0 && codec !== 1 && codec !== 2 && codec !== 3)
    throw new AokanaWaveBoxError(0x0e, 'Aokana WaveBox selector has an invalid codec');
  if (word(4) !== 0x20207762)
    throw new AokanaWaveBoxError(0x11000001, 'Aokana WaveBox bw marker does not match');
  return {
    raw,
    resetDataOffset: word(0),
    field08: word(8),
    sourceFrameCount: word(12),
    sampleRate: word(16),
    channels: word(20),
    loopEnabled: word(24),
    loopStartFrame: word(28),
    loopLeft: {predictor: word(32), step: word(36)},
    loopRight: {predictor: word(40), step: word(44)},
    codec,
    field34: word(52),
    huffmanLoopBitOffset: word(56),
    hfAdpcmShiftParameter: word(60),
  };
}

/** A copied byte can become undefined; unread zero-initialized header bytes remain defined. */
export function requireAokanaWaveHeaderBytes(
  mask: Uint8Array,
  offset: number,
  length: number,
): void {
  if (offset + length > mask.length || mask.subarray(offset, offset + length).includes(0))
    throw new Error('Aokana WaveBox consumes unwritten header bytes');
}
