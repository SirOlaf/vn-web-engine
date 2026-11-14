import {readTheoraOgg, TheoraDecoder, type TheoraStream} from '../../formats/theora/index.js';

/** Native BT.601 conversion tables built by the CTheora constructor 0x140015b50. Luma is
 * not range-expanded; red/blue offsets are added to Y, green uses the summed 16.16 parts. */
const crRed = new Int32Array(256),
  cbBlue = new Int32Array(256),
  crGreen = new Int32Array(256),
  cbGreen = new Int32Array(256);
for (let index = 0; index < 256; index++) {
  crRed[index] = (index * 0x166e9 - 0xb2f480) >> 16;
  cbBlue[index] = (index * 0x1c5a2 - 0xe25100) >> 16;
  crGreen[index] = 0x5b6900 - index * 0xb6d2;
  cbGreen[index] = 0x2c8c80 - index * 0x5819;
}
const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);

/** One CTheora decode stream (main or mask): the decode thread 0x140017010 run up to the
 * target frame. */
class TheoraStreamState {
  readonly decoder: TheoraDecoder;
  /** +0x220 */
  ended = false;
  /** +0x221 */
  newFrame = false;
  /** +0x228 */
  decoded = -1;
  /** +0x22c */
  target = 0;
  /** Bumped whenever the decoder's reference frame changes. */
  frameRevision = 0;
  private packet = 0;
  constructor(
    private readonly stream: TheoraStream,
    private readonly loop: boolean,
  ) {
    this.decoder = new TheoraDecoder(stream.info, stream.setup);
  }
  /** Runs the decode thread until it would block (`!end && target <= decoded`). */
  pump(): void {
    const packets = this.stream.packets;
    while (!this.ended && this.target > this.decoded) {
      if (this.packet >= packets.length) {
        // End of data: a looping stream seeks to 0; the header packets fed again fail to
        // decode and are not counted, so decoding resumes at the first data packet.
        if (!this.loop || !packets.length) this.ended = true;
        else this.packet = 0;
        continue;
      }
      const packet = packets[this.packet++]!;
      const skipping = this.target - this.decoded > 1;
      // While behind, only intra frames are decoded; skipped packets are still counted.
      if (!skipping || (packet.length > 0 && !(packet[0]! & 0x40))) {
        let duplicate: boolean;
        if (!packet.length) duplicate = true;
        else {
          try {
            duplicate = !this.decoder.decode(packet);
          } catch {
            // th_decode_packetin errors skip the packet without counting it.
            continue;
          }
          this.frameRevision++;
        }
        this.newFrame = !duplicate;
      }
      this.decoded++;
    }
  }
}

/** Main stream counters after the decode threads reached the target. */
export interface ArtemisTheoraThreadState {
  /** +0x220 of the main stream. */
  readonly ended: boolean;
  /** +0x228 of the main stream. */
  readonly decoded: number;
}

/** Picture geometry of a Theora stream as CTheora uses it. */
export interface ArtemisTheoraPicture {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  /** Rows from the top; the identification header counts pic_y from the bottom. */
  readonly y: number;
  readonly frameRate: number;
}

/** The CTheora decode threads 0x140017010 of the main stream and the `_m` mask stream, with
 * the conversion 0x140016390 performs once both reached the target. `ArtemisTheoraVideo`
 * drives them synchronously or through a worker that owns another instance. */
export class ArtemisTheoraThreads {
  readonly picture: ArtemisTheoraPicture;
  private readonly main: TheoraStreamState;
  private readonly mask: TheoraStreamState | null;
  private converted: readonly number[] = [];

  constructor(main: TheoraStream, loop: boolean, mask: TheoraStream | null) {
    this.main = new TheoraStreamState(main, loop);
    this.mask = mask ? new TheoraStreamState(mask, loop) : null;
    this.picture = artemisTheoraPicture(main);
  }

  /** Parses the streams; null when `main` is not a Theora stream. A mask that fails to
   * open is dropped (0x140017360). */
  static open(
    main: Uint8Array,
    loop: boolean,
    mask: Uint8Array | null,
  ): ArtemisTheoraThreads | null {
    const stream = readStream(main);
    if (!stream) return null;
    return new ArtemisTheoraThreads(stream, loop, mask ? readStream(mask) : null);
  }

  get hasMask(): boolean {
    return this.mask !== null;
  }

  /** Sets both stream targets, as update does after its clock check. */
  setTarget(frame: number): void {
    this.main.target = frame;
    if (this.mask) this.mask.target = frame;
  }

  /** Runs both decode threads until they block. Returns true when `pixels` (RGBA,
   * picture-sized) received a new picture: on a new main or mask frame, unless the planes
   * are the ones converted last. */
  decode(pixels: Uint8Array): boolean {
    const main = this.main;
    main.pump();
    this.mask?.pump();
    if (main.ended && main.target > main.decoded) return false;
    if (!main.newFrame && !this.mask?.newFrame) return false;
    main.newFrame = false;
    return this.convert(pixels);
  }

  get state(): ArtemisTheoraThreadState {
    return {ended: this.main.ended, decoded: this.main.decoded};
  }

  /** Conversion of 0x140016390: the native tables, 4:2:0 chroma indexing for every pixel
   * format (row floor(picY/2) + floor(r/2), column floor(picX/2) + floor(c/2)) and alpha
   * 0xff, or the luma of the mask stream at the main stream's picture offsets. */
  private convert(pixels: Uint8Array): boolean {
    const planes = this.main.decoder.frame;
    if (!planes) return false;
    const maskPlanes = this.mask?.decoder.frame ?? null;
    const state = [this.main.frameRevision, this.mask?.frameRevision ?? -1];
    // Converting unchanged planes reproduces the same pixels; skip that work.
    if (state[0] === this.converted[0] && state[1] === this.converted[1]) return false;
    this.converted = state;
    const luma = planes[0]!,
      cb = planes[1]!,
      cr = planes[2]!;
    const alpha = maskPlanes?.[0] ?? null;
    const {width, height, x: picX, y: picY} = this.picture;
    for (let row = 0; row < height; row++) {
      const y = picY + row,
        chromaY = (picY >> 1) + (row >> 1);
      // Planes are stored bottom-up.
      const lumaRow = (luma.height - 1 - y) * luma.width + picX;
      const chromaRow = (cb.height - 1 - chromaY) * cb.width + (picX >> 1);
      const alphaRow = alpha ? (alpha.height - 1 - y) * alpha.width + picX : 0;
      let out = row * width * 4;
      for (let column = 0; column < width; column++) {
        const value = luma.data[lumaRow + column]!;
        const chroma = chromaRow + (column >> 1);
        const u = cb.data[chroma]!,
          v = cr.data[chroma]!;
        pixels[out] = clamp(value + crRed[v]!);
        pixels[out + 1] = clamp(value + ((cbGreen[u]! + crGreen[v]!) >> 16));
        pixels[out + 2] = clamp(value + cbBlue[u]!);
        pixels[out + 3] = alpha ? alpha.data[alphaRow + column]! : 0xff;
        out += 4;
      }
    }
    return true;
  }
}

export function artemisTheoraPicture(stream: TheoraStream): ArtemisTheoraPicture {
  const info = stream.info;
  return {
    width: info.pictureWidth,
    height: info.pictureHeight,
    x: info.pictureX,
    y: info.macroblockHeight * 16 - info.pictureHeight - info.pictureY,
    frameRate: Math.fround(
      Math.fround(info.frameRateNumerator) / Math.fround(info.frameRateDenominator),
    ),
  };
}

export function readStream(bytes: Uint8Array): TheoraStream | null {
  try {
    return readTheoraOgg(bytes);
  } catch {
    return null;
  }
}

export type ArtemisTheoraThreadRequest =
  | {type: 'open'; main: Uint8Array; loop: boolean; mask: Uint8Array | null}
  /** `buffer` returns a picture buffer for reuse. */
  | {type: 'target'; frame: number; buffer: ArrayBuffer | null};
export type ArtemisTheoraThreadResponse =
  | {type: 'state'; ended: boolean; decoded: number; picture: ArrayBuffer | null}
  | {type: 'error'; message: string};

/** The worker side of `ArtemisTheoraThreads`: open starts decoding toward target 0, as the
 * native threads do once the stream opens, and each target request decodes toward the new
 * target. Every request answers with the main stream state and, when there is a new
 * picture, its RGBA buffer, which the caller owns until it returns it. */
export class ArtemisTheoraThreadService {
  private threads: ArtemisTheoraThreads | null = null;
  private spare: ArrayBuffer | null = null;

  handle(request: ArtemisTheoraThreadRequest): ArtemisTheoraThreadResponse {
    try {
      if (request.type === 'open') {
        if (this.threads) throw Error('Artemis video threads already open');
        this.threads = ArtemisTheoraThreads.open(request.main, request.loop, request.mask);
        if (!this.threads) throw Error('Artemis video threads opened without a Theora stream');
      } else {
        if (!this.threads) throw Error('Artemis video threads are not open');
        if (request.buffer) this.spare = request.buffer;
        this.threads.setTarget(request.frame);
      }
      const threads = this.threads;
      const {width, height} = threads.picture;
      const buffer = this.spare ?? new ArrayBuffer(width * height * 4);
      this.spare = null;
      const picture = threads.decode(new Uint8Array(buffer));
      if (!picture) this.spare = buffer;
      return {type: 'state', ...threads.state, picture: picture ? buffer : null};
    } catch (error) {
      return {type: 'error', message: error instanceof Error ? error.message : String(error)};
    }
  }
}
