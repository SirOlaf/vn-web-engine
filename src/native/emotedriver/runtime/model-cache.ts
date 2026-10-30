import {readEmoteModel, type EmoteX64Model} from '../../../formats/kirikiri/emote-model.js';
import {PsbFile} from '../../../formats/kirikiri/psb.js';
import {EMOTE_PSB_KEYS} from '../../../formats/kirikiri/psb-filter.js';
import {EMOTEDRIVER_X64_SHA256} from '../build.js';

interface Entry {
  readonly bytes: Uint8Array;
  readonly model: EmoteX64Model;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const words = Math.floor(a.length / 4);
  if ((a.byteOffset | b.byteOffset) & 3) {
    const av = new DataView(a.buffer, a.byteOffset, a.byteLength),
      bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < words * 4; i += 4)
      if (av.getUint32(i, true) !== bv.getUint32(i, true)) return false;
  } else {
    const av = new Uint32Array(a.buffer, a.byteOffset, words),
      bv = new Uint32Array(b.buffer, b.byteOffset, words);
    for (let i = 0; i < words; i++) if (av[i] !== bv[i]) return false;
  }
  for (let i = words * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Fresh identity keys for each file/resource group; definition data stays immutable. */
function instantiate(model: EmoteX64Model): EmoteX64Model {
  return {
    ...model,
    sources: new Map(
      [...model.sources].map(([name, source]) => [
        name,
        {...source, texture: source.texture ? {...source.texture} : null},
      ]),
    ),
    objects: new Map(
      [...model.objects].map(([name, object]) => [
        name,
        {
          ...object,
          motions: new Map([...object.motions].map(([label, motion]) => [label, {...motion}])),
        },
      ]),
    ),
  };
}

/** Device-local parsed definitions, bounded by entry count and retained source bytes. */
export class EmoteModelCache {
  private readonly entries: Entry[] = [];
  private bytes = 0;

  constructor(
    private readonly capacity = 4,
    private readonly byteLimit = 32 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 1
    )
      throw new RangeError('Invalid E-mote model cache limits');
  }

  read(bytes: Uint8Array): EmoteX64Model {
    const index = this.entries.findIndex((entry) => sameBytes(entry.bytes, bytes));
    if (index >= 0) {
      const entry = this.entries.splice(index, 1)[0]!;
      this.entries.push(entry);
      return instantiate(entry.model);
    }
    // Callers may reuse or change their buffers after the synchronous call.
    // Neither cache identity nor retained texture data may borrow those bytes.
    const snapshot = new Uint8Array(bytes),
      model = readEmoteModel(
        new PsbFile(snapshot, {
          driverSha256: EMOTEDRIVER_X64_SHA256,
          headerKey: EMOTE_PSB_KEYS.get(EMOTEDRIVER_X64_SHA256),
        }),
        EMOTEDRIVER_X64_SHA256,
      );
    if (snapshot.byteLength <= this.byteLimit) {
      while (
        this.entries.length >= this.capacity ||
        this.bytes + snapshot.byteLength > this.byteLimit
      ) {
        this.bytes -= this.entries.shift()!.bytes.byteLength;
      }
      this.entries.push({bytes: snapshot, model});
      this.bytes += snapshot.byteLength;
    }
    return instantiate(model);
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }
}
