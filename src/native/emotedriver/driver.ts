import {PsbFile} from '../../formats/psb/psb.js';
import {readEmoteModel, type EmoteModel} from '../../formats/emote/model.js';
import {EmoteMotionClip, EmoteResource} from './clip.js';
import {EmoteRandom} from './controls.js';
import {EmotePlayer, EmoteUnsupportedError} from './player.js';

/** An exact `emotedriver.dll` build: its SDK strings and the PSB header filter key. */
export interface EmoteDriverProfile {
  readonly sha256: string;
  /** `EmoteGetSDKVersion`. */
  readonly sdkVersion: string;
  /** `EmoteGetBuildDateTime`. */
  readonly buildDateTime: string;
  /** The keystream key of filtered PSB headers (an .rdata string of the driver). */
  readonly psbKey: number;
}

const profiles: ReadonlyMap<string, EmoteDriverProfile> = new Map(
  [
    {
      // x64 D3D11 build (Artemis Rev.3258); exports 0x180004130/0x180004120, key at
      // file offset 0x8f7b8.
      sha256: '80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051',
      sdkVersion: '3.9.8',
      buildDateTime: '2022/12/28-13:02:35',
      psbKey: 49327924,
    },
  ].map((profile) => [profile.sha256, Object.freeze(profile)]),
);

/** The driver profile of an exact DLL hash; an unknown build is refused. */
export function emoteDriverProfile(sha256: string): EmoteDriverProfile {
  const profile = profiles.get(sha256.toLowerCase());
  if (!profile) throw new EmoteUnsupportedError(`emotedriver.dll build ${sha256}`);
  return profile;
}

/**
 * The driver's device (`CreatePlayer`, device slot +0x48): reads motion files into models and
 * builds players over them. Models are immutable and shared by players; the most recently
 * used ones stay cached by name.
 */
export class EmoteDevice {
  private readonly models = new Map<string, EmoteModel>();
  /** The process RNG 0x180028950: Marsaglia's three words and `_time64` at first use. */
  readonly random: EmoteRandom;

  constructor(
    readonly profile: EmoteDriverProfile,
    seconds: number,
    private readonly cacheSize = 16,
  ) {
    this.random = new EmoteRandom(seconds);
  }

  /** The cached model of `name`, if any. */
  cachedModel(name: string): EmoteModel | undefined {
    const model = this.models.get(name);
    if (model) {
      this.models.delete(name);
      this.models.set(name, model);
    }
    return model;
  }

  /** Parses `bytes` as the motion file `name` and caches it. */
  loadModel(name: string, bytes: Uint8Array): EmoteModel {
    const cached = this.cachedModel(name);
    if (cached) return cached;
    const model = readEmoteModel(new PsbFile(bytes, this.profile.psbKey));
    this.models.set(name, model);
    while (this.models.size > this.cacheSize) this.models.delete(this.models.keys().next().value!);
    return model;
  }

  /** A player over one motion file; the player selects its base object and motion. */
  createPlayer(models: readonly EmoteModel[]): EmotePlayer {
    if (models.length !== 1) throw new EmoteUnsupportedError('E-mote player over several files');
    const clip = new EmoteMotionClip(new EmoteResource(models));
    return new EmotePlayer(models[0]!.metadata, clip, {random: this.random});
  }
}
