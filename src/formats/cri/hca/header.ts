import {BinaryReader, checkRange} from '../../../core/binary.js';
export interface HcaLoop {
  /** Audible sample indices; end is exclusive. */ start: number;
  end: number;
  startBlock: number;
  endBlock: number;
  startDelay: number;
  endPadding: number;
}
export interface HcaHeader {
  version: number;
  headerSize: number;
  channels: number;
  sampleRate: number;
  blockCount: number;
  encoderDelay: number;
  encoderPadding: number;
  sampleCount: number;
  blockSize: number;
  minResolution: number;
  maxResolution: number;
  trackCount: number;
  channelConfig: number;
  totalBands: number;
  baseBands: number;
  stereoBands: number;
  bandsPerHfrGroup: number;
  msStereo: number;
  reserved: number;
  cipher: number;
  ath: number;
  volume: number;
  loop?: HcaLoop;
}
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let j = 0; j < 8; j++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 0xffff;
  CRC_TABLE[i] = crc;
}
/** Native 1401ae9c8: CRC-16, polynomial 0x8005, initial 0, no reflection/XOR. */
export function hcaCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 8) ^ byte]!) & 0xffff;
  return crc;
}
export function hcaTag(bytes: Uint8Array, offset = 0): string {
  checkRange(bytes.length, offset, 4);
  return Array.from(bytes.subarray(offset, offset + 4), (b) => String.fromCharCode(b & 0x7f)).join(
    '',
  );
}
export function hcaHeaderSize(bytes: Uint8Array): number {
  checkRange(bytes.length, 0, 8);
  if (hcaTag(bytes) !== 'HCA\0') throw new Error('Invalid HCA magic');
  const size = bytes[6]! * 256 + bytes[7]!;
  if (size < 42) throw new Error('HCA header is too short');
  return size;
}
/** This implementation deliberately accepts only the HCA 2.0 profiles verified in this game. */
export function parseHcaHeader(bytes: Uint8Array, fileSize?: number): HcaHeader {
  const size = hcaHeaderSize(bytes);
  checkRange(bytes.length, 0, size);
  if (hcaCrc(bytes.subarray(0, size)) !== 0) throw new Error('HCA header CRC mismatch');
  const r = new BinaryReader(bytes.subarray(0, size - 2));
  r.position = 4;
  const version = r.u16();
  r.u16();
  if (version !== 0x200) throw new Error(`Unsupported HCA version 0x${version.toString(16)}`);
  function tag(expected: string): void {
    if (hcaTag(r.bytes, r.position) !== expected) throw new Error(`Expected HCA ${expected}`);
    r.take(4);
  }
  tag('fmt\0');
  const channels = r.u8(),
    sampleRate = r.u8() * 65536 + r.u16(),
    blockCount = r.u32(),
    encoderDelay = r.u16(),
    encoderPadding = r.u16();
  tag('comp');
  const blockSize = r.u16(),
    minResolution = r.u8(),
    maxResolution = r.u8(),
    trackCount = r.u8() || 1,
    channelConfig = r.u8();
  const totalBands = r.u8(),
    baseBands = r.u8(),
    stereoBands = r.u8(),
    bandsPerHfrGroup = r.u8(),
    msStereo = r.u8(),
    reserved = r.u8();
  let cipher = 0,
    ath = 0,
    volume = 1,
    loop: HcaLoop | undefined;
  const seen = new Set<string>();
  while (r.position < r.bytes.length) {
    const name = hcaTag(r.bytes, r.position);
    r.take(4);
    if (seen.has(name)) throw new Error(`Duplicate HCA chunk ${name}`);
    seen.add(name);
    if (name === 'pad\0') break;
    if (name === 'ciph') cipher = r.u16();
    else if (name === 'ath\0') ath = r.u16();
    else if (name === 'rva\0') volume = r.f32();
    else if (name === 'comm') r.take(r.u8());
    else if (name === 'loop') {
      const startBlock = r.u32(),
        endBlock = r.u32(),
        startDelay = r.u16(),
        endPadding = r.u16();
      loop = {
        startBlock,
        endBlock,
        startDelay,
        endPadding,
        start: startBlock * 1024 + startDelay - encoderDelay,
        end: (endBlock + 1) * 1024 - endPadding - encoderDelay,
      };
    } else throw new Error(`Unsupported HCA chunk ${JSON.stringify(name)}`);
  }
  const sampleCount = blockCount * 1024 - encoderDelay - encoderPadding;
  if (
    channels < 1 ||
    channels > 2 ||
    sampleRate < 1 ||
    sampleRate > 192000 ||
    blockSize < 8 ||
    blockCount < 1 ||
    sampleCount < 1
  )
    throw new Error('Invalid HCA stream dimensions');
  const independent =
    trackCount === 1 &&
    !bandsPerHfrGroup &&
    baseBands === totalBands &&
    [118, 128].includes(totalBands) &&
    channelConfig === (channels === 1 ? 1 : 0);
  const movie =
    channels === 2 &&
    trackCount === 2 &&
    channelConfig === 1 &&
    totalBands === 128 &&
    baseBands === 96 &&
    bandsPerHfrGroup === 4;
  if (
    minResolution !== 1 ||
    maxResolution !== 15 ||
    stereoBands ||
    msStereo ||
    reserved ||
    (!independent && !movie)
  )
    throw new Error('Unsupported HCA coding profile');
  if (cipher !== 0) throw new Error(`Unsupported HCA cipher ${cipher}`);
  if (ath !== 0) throw new Error(`Unsupported HCA ATH ${ath}`);
  if (!Number.isFinite(volume) || volume < 0) throw new Error('Invalid HCA volume');
  if (
    loop &&
    (loop.startBlock > loop.endBlock ||
      loop.endBlock >= blockCount ||
      loop.startDelay > 1024 ||
      loop.endPadding > 1024 ||
      loop.start < 0 ||
      loop.end > sampleCount ||
      loop.end <= loop.start)
  )
    throw new Error('Invalid HCA loop range');
  if (fileSize !== undefined && fileSize !== size + blockCount * blockSize)
    throw new Error('HCA payload size mismatch');
  return {
    version,
    headerSize: size,
    channels,
    sampleRate,
    blockCount,
    encoderDelay,
    encoderPadding,
    sampleCount,
    blockSize,
    minResolution,
    maxResolution,
    trackCount,
    channelConfig,
    totalBands,
    baseBands,
    stereoBands,
    bandsPerHfrGroup,
    msStereo,
    reserved,
    cipher,
    ath,
    volume,
    ...(loop ? {loop} : {}),
  };
}
