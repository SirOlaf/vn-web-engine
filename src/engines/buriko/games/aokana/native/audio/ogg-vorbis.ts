import {oggPageChecksum as aokanaOggChecksum} from '../../../../../../formats/ogg/checksum.js';
import {AokanaWaveBoxError} from './wavebox-header.js';

export {aokanaOggChecksum};

export interface AokanaVorbisIdentification {
  readonly channels: number;
  readonly sampleRate: number;
  readonly shortBlock: number;
  readonly longBlock: number;
}
export interface AokanaOggVorbisLink extends AokanaVorbisIdentification {
  readonly serial: number;
  readonly bytes: Uint8Array;
  readonly finalGranule: bigint | null;
}
export interface AokanaVorbisPcmLink extends AokanaVorbisIdentification {
  /** Planes use encoded Vorbis order, before BGI's independent output permutation. */
  readonly planes: readonly Float32Array[];
  readonly frames: number;
}

function identification(packet: Uint8Array): AokanaVorbisIdentification {
  if (
    packet.length < 30 ||
    packet[0] !== 1 ||
    ![118, 111, 114, 98, 105, 115].every((byte, index) => packet[index + 1] === byte)
  ) {
    throw new AokanaWaveBoxError(0x10000000, 'Aokana Vorbis identification packet is absent');
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const channels = packet[11]!,
    sampleRate = view.getUint32(12, true);
  const shortExponent = packet[28]! & 15,
    longExponent = packet[28]! >>> 4;
  if (
    view.getUint32(7, true) !== 0 ||
    channels === 0 ||
    sampleRate === 0 ||
    shortExponent < 6 ||
    longExponent < shortExponent ||
    longExponent > 13 ||
    (packet[29]! & 1) === 0
  ) {
    throw new AokanaWaveBoxError(0x10000000, 'Aokana Vorbis identification packet is invalid');
  }
  return {channels, sampleRate, shortBlock: 1 << shortExponent, longBlock: 1 << longExponent};
}

interface PendingLink {
  serial: number;
  pages: Uint8Array[];
  packet: number[];
  identification: AokanaVorbisIdentification | null;
  ended: boolean;
  finalGranule: bigint | null;
}

/** Ogg page synchronization/CRC and sequential logical links; codec decoding remains a browser primitive. */
export function parseAokanaOggVorbisLinks(bytes: Uint8Array): readonly AokanaOggVorbisLink[] {
  const links: PendingLink[] = [];
  let current: PendingLink | null = null,
    cursor = 0;
  while (cursor + 27 <= bytes.length) {
    if (
      bytes[cursor] !== 79 ||
      bytes[cursor + 1] !== 103 ||
      bytes[cursor + 2] !== 103 ||
      bytes[cursor + 3] !== 83 ||
      bytes[cursor + 4] !== 0
    ) {
      cursor++;
      continue;
    }
    const segments = bytes[cursor + 26]!,
      headerSize = 27 + segments;
    if (cursor + headerSize > bytes.length) break;
    let size = headerSize;
    for (let index = 0; index < segments; index++) size += bytes[cursor + 27 + index]!;
    if (cursor + size > bytes.length) break;
    const page = bytes.subarray(cursor, cursor + size),
      view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    if (aokanaOggChecksum(page) !== view.getUint32(22, true)) {
      cursor++;
      continue;
    }
    cursor += size;
    const serial = view.getUint32(14, true),
      flags = page[5]!;
    if (current === null || (current.ended && (flags & 2) !== 0)) {
      current = {
        serial,
        pages: [],
        packet: [],
        identification: null,
        ended: false,
        finalGranule: null,
      };
      links.push(current);
    }
    if (current.serial !== serial) continue;
    current.pages.push(page);
    const granule = view.getBigInt64(6, true);
    if (granule >= 0) current.finalGranule = granule;
    current.ended = (flags & 4) !== 0;
    if (current.identification === null) {
      let read = headerSize;
      for (let index = 0; index < segments; index++) {
        const length = page[27 + index]!;
        for (let at = 0; at < length; at++) current.packet.push(page[read + at]!);
        read += length;
        if (length !== 255) {
          current.identification = identification(Uint8Array.from(current.packet));
          break;
        }
      }
    }
  }
  if (links.length === 0)
    throw new AokanaWaveBoxError(0x10000000, 'Aokana source has no valid Ogg page');
  return links.map((link) => {
    if (link.identification === null)
      throw new AokanaWaveBoxError(
        0x10000000,
        'Aokana source has an incomplete Vorbis identification packet',
      );
    const bytes = new Uint8Array(link.pages.reduce((sum, page) => sum + page.length, 0));
    let at = 0;
    for (const page of link.pages) {
      bytes.set(page, at);
      at += page.length;
    }
    return {...link.identification, serial: link.serial, bytes, finalGranule: link.finalGranule};
  });
}

// Vorbis encoded plane -> Web Audio speaker plane. Native's eight-channel map differs.
const browserPlaneOrder: readonly (readonly number[])[] = [
  [],
  [0],
  [0, 1],
  [0, 2, 1],
  [0, 1, 2, 3],
  [0, 2, 1, 3, 4],
  [0, 2, 1, 4, 5, 3],
  [0, 2, 1, 5, 6, 4, 3],
  [0, 2, 1, 6, 7, 4, 5, 3],
];

/** Browser Vorbis platform profile. No live context, resampling, gain, loops or playback are involved. */
export async function decodeAokanaOggVorbis(
  bytes: Uint8Array,
  Context: typeof OfflineAudioContext = OfflineAudioContext,
): Promise<readonly AokanaVorbisPcmLink[]> {
  const result: AokanaVorbisPcmLink[] = [];
  for (const link of parseAokanaOggVorbisLinks(bytes)) {
    const context = new Context({
      numberOfChannels: link.channels,
      length: 1,
      sampleRate: link.sampleRate,
    });
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(link.bytes.slice().buffer);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'EncodingError') {
        throw new AokanaWaveBoxError(0x10000000, 'Browser Vorbis rejected Aokana compressed audio');
      }
      throw error;
    }
    if (decoded.sampleRate !== link.sampleRate || decoded.numberOfChannels !== link.channels) {
      throw new Error('Browser Vorbis changed the identified Aokana PCM geometry');
    }
    // Chromium/FFmpeg retains encoded order for >8 channels (discrete/UNSPEC layout).
    const order =
      browserPlaneOrder[link.channels] ??
      Array.from({length: link.channels}, (_, channel) => channel);
    const planes = order.map((channel) => decoded.getChannelData(channel).slice());
    result.push({...link, planes, frames: decoded.length});
  }
  return result;
}
