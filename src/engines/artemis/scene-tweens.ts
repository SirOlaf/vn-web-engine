import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';
import {artemisDecimal, artemisInteger} from './numbers.js';

export const artemisTweenTypes = [
  'in',
  'out',
  'show',
  'hide',
  'backlog_down_in',
  'backlog_down_out',
  'backlog_up_in',
  'backlog_up_out',
] as const;
export type ArtemisTweenType = (typeof artemisTweenTypes)[number];
export type ArtemisTweenParameter =
  'left' | 'top' | 'alpha' | 'xscale' | 'yscale' | 'rotate' | 'unknown';
export interface ArtemisTweenDescriptor {
  readonly parameter: ArtemisTweenParameter;
  readonly entire: boolean;
  /** Native dispatch id 0..30, or 31 for an unrecognized spelling. */
  readonly ease: number;
  readonly diff: number;
  readonly time: number;
  readonly delay: number;
  readonly randomDelay: boolean;
  readonly outgoing: boolean;
}
const parameters = ['left', 'top', 'alpha', 'xscale', 'yscale', 'rotate'] as const;
const eases = [
  'none',
  ...[
    'quad',
    'cubic',
    'quart',
    'quint',
    'expo',
    'circ',
    'sine',
    'back',
    'elastic',
    'bounce',
  ].flatMap((family) => ['easein_', 'easeout_', 'easeinout_'].map((kind) => kind + family)),
];
const messageTweenTypes = ['in', 'out', 'show', 'hide'] as const;
export type ArtemisMessageTweenType = (typeof messageTweenTypes)[number];
const backlogTweenTypes = [
  'backlog_down_in',
  'backlog_down_out',
  'backlog_up_in',
  'backlog_up_out',
] as const;
export type ArtemisBacklogTweenType = (typeof backlogTweenTypes)[number];
function tweenType(value: string | undefined): ArtemisTweenType | undefined {
  return artemisTweenTypes.find((type) => type === value);
}

/** cdae0 configures text effect vectors; it does not start an animation or advance time.
 * Ordinary vectors are script-owned per message name; four backlog vectors are global.
 */
export class ArtemisSceneTweens {
  private readonly layers = new Map<string, Map<ArtemisTweenType, ArtemisTweenDescriptor[]>>();
  private readonly backlog = new Map<ArtemisTweenType, ArtemisTweenDescriptor[]>();
  constructor(
    executableSha256: string,
    private readonly currentMessageLayer: () => string,
  ) {
    artemisRevision(executableSha256);
  }
  /** bf210 empties the per-message and backlog vector maps (3740..3768). */
  reset(): void {
    this.layers.clear();
    this.backlog.clear();
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'scetween') return false;
    const mode = tag.args.get('mode');
    if (mode !== 'init' && mode !== 'add') return true;
    const type = tweenType(tag.args.get('type'));
    if (!type) return true;
    const vector = this.vector(type);
    if (mode === 'init') {
      vector.length = 0;
      return true;
    }
    const value = tag.args.get('param') ?? '';
    const entire = parameters.some((parameter) => value === 'entire' + parameter);
    const parameter =
      parameters.find((parameter) => value === parameter || value === 'entire' + parameter) ??
      'unknown';
    // Native rounds atof to float before the single-precision division.
    let diff = Math.fround(artemisDecimal(tag.args.get('diff') ?? ''));
    if (parameter === 'alpha') diff = Math.fround(diff / 255);
    else if (parameter === 'xscale' || parameter === 'yscale') diff = Math.fround(diff / 100);
    if (!Number.isFinite(diff)) throw Error('Unsupported Artemis tween diff');
    const ease = eases.indexOf(tag.args.get('ease') ?? '');
    const random = tag.args.get('randomdelay');
    const descriptor: ArtemisTweenDescriptor = Object.freeze({
      parameter,
      entire,
      ease: ease < 0 ? 31 : ease,
      diff,
      time: artemisInteger(tag.args.get('time') ?? tag.args.get('msec') ?? ''),
      delay: artemisInteger(tag.args.get('delay') ?? ''),
      randomDelay: random !== undefined && random !== '0',
      outgoing: type === 'out' || type === 'hide' || type.endsWith('_out'),
    });
    vector.push(descriptor);
    return true;
  }
  /** Copies the vector for a text/frame owner; snapshots survive later init/add. */
  snapshot(
    type: ArtemisTweenType,
    messageLayer = this.currentMessageLayer(),
  ): readonly ArtemisTweenDescriptor[] {
    return this.vector(type, messageLayer).slice();
  }
  /** Scenario archive sections 0xd, 0xe, 0x3b, 0x3c: the per-message `in`, `out`, `show`
   * and `hide` maps (+0x3730..+0x3760), including created empty vectors. */
  saveFields(): Record<ArtemisMessageTweenType, Map<string, ArtemisTweenDescriptor[]>> {
    const fields = Object.fromEntries(
      messageTweenTypes.map((type) => [type, new Map<string, ArtemisTweenDescriptor[]>()]),
    ) as Record<ArtemisMessageTweenType, Map<string, ArtemisTweenDescriptor[]>>;
    for (const [layer, map] of this.layers)
      for (const [type, vector] of map)
        if (!type.startsWith('backlog_'))
          fields[type as ArtemisMessageTweenType].set(layer, vector.slice());
    return fields;
  }
  /** Loader reads replace the four per-message maps. */
  loadFields(
    fields: Readonly<
      Record<ArtemisMessageTweenType, ReadonlyMap<string, readonly ArtemisTweenDescriptor[]>>
    >,
  ): void {
    this.layers.clear();
    for (const type of messageTweenTypes)
      for (const [layer, vector] of fields[type]) {
        let map = this.layers.get(layer);
        if (!map) this.layers.set(layer, (map = new Map()));
        map.set(type, vector.slice());
      }
  }
  /** CBackLog tween vectors (section 0x1f). */
  backlogFields(): Record<ArtemisBacklogTweenType, ArtemisTweenDescriptor[]> {
    return Object.fromEntries(
      backlogTweenTypes.map((type) => [type, (this.backlog.get(type) ?? []).slice()]),
    ) as Record<ArtemisBacklogTweenType, ArtemisTweenDescriptor[]>;
  }
  loadBacklogFields(
    fields: Readonly<Record<ArtemisBacklogTweenType, readonly ArtemisTweenDescriptor[]>>,
  ): void {
    this.backlog.clear();
    for (const type of backlogTweenTypes) this.backlog.set(type, fields[type].slice());
  }
  private vector(type: ArtemisTweenType, messageLayer?: string): ArtemisTweenDescriptor[] {
    let map = this.backlog;
    if (!type.startsWith('backlog_')) {
      const name = messageLayer ?? this.currentMessageLayer();
      map = this.layers.get(name) ?? new Map();
      this.layers.set(name, map);
    }
    let vector = map.get(type);
    if (!vector) {
      vector = [];
      map.set(type, vector);
    }
    return vector;
  }
}
