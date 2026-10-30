import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisLayerCommands} from './layer-commands.js';
import type {ArtemisLayerPropertyPatch} from './layer-properties.js';
import type {ArtemisScene, ArtemisSceneLayer} from './scene.js';
import {
  ArtemisFloatTween,
  ArtemisTweenQueue,
  artemisEaseId,
  type ArtemisRegisteredTween,
  type ArtemisTweenRegistry,
} from './tween.js';
import {artemisDecimal, artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

export interface ArtemisLayerTweenHost<T> {
  /** Inner-actor setter for one property; tweens never touch the outer wrapper alpha. */
  applyImageProperties(id: string, layer: T, properties: ArtemisLayerPropertyPatch): void;
  /** c7260(script, 1, tag, message 0x1403721a0). */
  layerNotFound(tag: AsbTag): void;
  /** c6160(script, 4) after a `sync` tween is registered. */
  enterRunMode(mode: 4): void;
  /** b5be0 bound to the caret: previous run mode c74 = c70, then c70 = 0. */
  endSyncWait(): void;
  /** `delete` completion: the lydel body 0x1400d6670 with the tag copy and replay flag. */
  deleteLayer(tag: AsbTag, recordHistory: boolean): void;
  /** `file`/`label`/`handler` completion: b73e0(script, 0, force 1, tag copy). */
  emitEvent(tag: AsbTag): void;
  /** b9cd0 records the synthesized end-state `lyprop`. */
  recordLayerProperties(tag: AsbTag): void;
}

type Parameter = 'left' | 'top' | 'alpha' | 'xscale' | 'yscale' | 'rotate';
const parameters: readonly Parameter[] = ['left', 'top', 'alpha', 'xscale', 'yscale', 'rotate'];
const scale: Partial<Record<Parameter, number>> = {alpha: 255, xscale: 100, yscale: 100};
function decimal(value: string): number {
  const number = Math.fround(artemisDecimal(value, 'Unsupported Artemis tween endpoint'));
  if (!Number.isFinite(number)) throw Error('Unsupported Artemis tween endpoint');
  return number;
}

/** A direct tween without a completion effect. Once its layer node is destroyed the setter
 * finds no actors and no `lytweendel` can reach the node's id set, so stepping it has no
 * observable effect. The registry drops it then instead of stepping it until it ends, which
 * for `loop=-1` is never; scripts that recreate a looping layer on every page would
 * otherwise grow the per-frame step without bound. */
class DetachedLayerTween<T> implements ArtemisRegisteredTween {
  constructor(
    private readonly layer: ArtemisSceneLayer<T>,
    private readonly tween: ArtemisFloatTween,
  ) {}
  tick(now: number): boolean {
    return this.layer.destroyed || this.tween.tick(now);
  }
  finish(): void {
    this.tween.finish();
  }
}

/** lytween 0x1400da830, lytweendel 0x1400dd3a0, tweenset 0x1400dd840 and /tweenset
 * 0x1400dd8f0 for direct scene layers. The setter holds the layer node, so a replaced or
 * deleted layer keeps animating its detached actors until the tween ends; a tween with no
 * completion effect leaves the registry as soon as the node is destroyed (see
 * `DetachedLayerTween`). Per-layer id sets mirror CArtemisLayer +0xf0.
 *
 * `tweenset` opens a CTweenQueue at script +0x3860 when none is open. While it is open,
 * lytween neither applies the start value nor registers the tween: it appends it to the
 * queue and adds the tag's `id` to the id set +0x3868. `/tweenset` registers the queue,
 * closes it and adds the queue id to the layer of every collected id (ids without a
 * layer are skipped), then clears the set. The root (`!`) and alias (`~`) fallbacks of
 * that lookup are refused like the lytween owner fallbacks. */
export class ArtemisLayerTweens<T> {
  private readonly ids = new WeakMap<ArtemisSceneLayer<T>, Set<number>>();
  private queue: ArtemisTweenQueue | null = null;
  /** std::set<string> +0x3868. */
  private readonly queued = new Set<string>();
  constructor(
    private readonly hash: string,
    private readonly scene: ArtemisScene<T>,
    private readonly registry: ArtemisTweenRegistry,
    private readonly commands: ArtemisLayerCommands,
    private readonly host: ArtemisLayerTweenHost<T>,
  ) {
    artemisRevision(hash);
  }
  dispatch(input: AsbTag, recordHistory = true): boolean {
    if (input.name === 'lytween') this.start(input, recordHistory);
    else if (input.name === 'lytweendel') this.remove(input, recordHistory);
    else if (input.name === 'tweenset') this.queue ??= new ArtemisTweenQueue(this.hash);
    else if (input.name === '/tweenset') this.close();
    else return false;
    return true;
  }
  /** Direct lookup first; only a missing id falls back to the root (`!`) or an alias (`~`). */
  private lookup(id: string): ArtemisSceneLayer<T> | undefined {
    const layer = this.scene.layer(id);
    if (!layer && id.startsWith('~')) throw Error('Unsupported Artemis layer alias tween owner');
    return layer;
  }
  private start(input: AsbTag, recordHistory: boolean): void {
    const args = new Map(input.args),
      tag: AsbTag = {...input, args};
    // std::map operator[] inserts the empty value that atoi/atof read as 0.
    const read = (key: string): string => {
      if (!args.has(key)) args.set(key, '');
      return args.get(key)!;
    };
    const id = read('id');
    if (id === '!') throw Error('Unsupported Artemis root layer tween owner');
    const layer = this.lookup(id);
    if (!layer) return this.host.layerNotFound(tag);
    const entry = this.scene.entry(id)!;
    if (entry.value === undefined) throw Error('Unsupported Artemis empty group tween owner');
    const ease = artemisEaseId(args.get('ease'));
    let from = decimal(read('from')),
      to = decimal(read('to'));
    const delay = args.has('delay') ? artemisInteger(args.get('delay')!) : 0;
    const time =
      artemisInteger(
        args.has('time') ? args.get('time')! : args.has('msec') ? args.get('msec')! : read('time'),
      ) >>> 0;
    const param = read('param') as Parameter;
    // Unknown parameters return before registration and history.
    if (!parameters.includes(param)) return;
    const divisor = scale[param];
    if (divisor) {
      from = Math.fround(from / divisor);
      to = Math.fround(to / divisor);
    }
    const remove = args.has('delete') && args.get('delete') !== '0';
    let loop = 0,
      yoyo = 0;
    if (args.has('loop')) loop = artemisInteger(args.get('loop')!);
    else if (args.has('repeat')) loop = artemisInteger(args.get('repeat')!);
    else if (args.has('yoyo')) yoyo = artemisInteger(args.get('yoyo')!);
    const loopDelay = args.has('loopdelay') ? artemisInteger(args.get('loopdelay')!) : 0;
    const set = (value: number) => {
      for (const actor of layer.actors())
        this.host.applyImageProperties(entry.id, actor, {[param]: value});
    };
    const sync = args.has('sync') && args.get('sync') !== '0';
    const copy: AsbTag = {...tag, args: new Map(args)};
    const silent = !sync && !remove && !['file', 'label', 'handler'].some((key) => args.has(key));
    const completion = sync
      ? () => this.host.endSyncWait()
      : remove
        ? () => this.host.deleteLayer(copy, recordHistory)
        : silent
          ? () => {}
          : () => this.host.emitEvent(copy);
    const tween = new ArtemisFloatTween(this.hash, from, to, time, set, completion, {
      ease,
      delay,
      loop,
      yoyo,
      loopDelay,
    });
    if (this.queue) {
      this.queue.append(tween);
      this.queued.add(id);
    } else {
      // Outside a tween group the start value is applied at creation.
      set(from);
      this.add(
        layer,
        this.registry.register(silent ? new DetachedLayerTween(layer, tween) : tween),
      );
    }
    if (sync) this.host.enterRunMode(4);
    if (!recordHistory) return;
    if (loop === -1 || yoyo === -1 || remove) {
      this.commands.append(id, tag);
      return;
    }
    // An odd yoyo count ends on `from`; everything else ends on `to`.
    const end = loop === 0 && yoyo & 1 ? 'from' : 'to';
    this.host.recordLayerProperties({
      kind: 'tag',
      name: 'lyprop',
      sourceLine: 0,
      args: new Map([
        ['id', id],
        [param, args.get(end)!],
      ]),
    });
  }
  private add(layer: ArtemisSceneLayer<T>, tween: number): void {
    let ids = this.ids.get(layer);
    if (!ids) this.ids.set(layer, (ids = new Set()));
    ids.add(tween);
  }
  private close(): void {
    if (!this.queue) return;
    const tween = this.registry.register(this.queue);
    this.queue = null;
    // Every collected layer receives the same id, so the set order is not observable.
    for (const id of this.queued) {
      const layer = this.scene.layer(id);
      if (layer) this.add(layer, tween);
      else if (id === '!') throw Error('Unsupported Artemis root layer tween group');
      else if (id.startsWith('~')) throw Error('Unsupported Artemis layer alias tween group');
    }
    this.queued.clear();
  }
  private remove(input: AsbTag, recordHistory: boolean): void {
    const id = input.args.get('id') ?? '';
    // The root layer set never receives tween ids here.
    const layer = id === '!' ? undefined : this.lookup(id),
      ids = layer && this.ids.get(layer);
    if (ids) {
      for (const tween of [...ids]) this.registry.finish(tween);
      ids.clear();
    }
    if (recordHistory) this.commands.erase(id, 'lytween', new Map());
  }
}
