import type {ArtemisDisplayObject} from './display-object.js';
import type {ArtemisLayerInfo} from './layer-info.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';
import type {ArtemisImageDimensions, ArtemisImageSource} from './image-loader.js';
import {ArtemisLayerCommands} from './layer-commands.js';
import {
  ArtemisLayerEventSlots,
  ArtemisLayerEvents,
  type ArtemisLayerEventSink,
  type ArtemisLayerEventType,
} from './layer-events.js';
import type {ArtemisLayerPropertyPatch} from './layer-properties.js';
import {ArtemisLayerTweens} from './layer-tweens.js';
import {ArtemisLayers, type ArtemisLayerHost} from './layers.js';
import {artemisRevision} from './revision.js';
import {ArtemisStage} from './stage.js';
import {
  ArtemisTransition,
  type ArtemisRuleBitmap,
  type ArtemisRuleImage,
  type ArtemisTransitionTween,
} from './transition.js';
import {ArtemisTweenRegistry} from './tween.js';
import type {ArtemisTheoraVideo} from './video.js';
import type {ArtemisEmoteLayer} from './emote-layer.js';

/** The script services the layer owner uses: the transition and sync-tween run modes, the
 * frame clock, tween completion events, the stage size and the skip state. */
export interface ArtemisLayerRunModeHost {
  /** c6160 entry: c74 = c70, c70 = `mode`. */
  enter(mode: number): void;
  /** c6480: c70 = c74, then the deferred script events. */
  release(): void;
  now(): number;
  /** Wait timestamp b94 of the current caret. */
  setWaitStart(ms: number): void;
  emit(tag: AsbTag): void;
  stageSize(): {readonly width: number; readonly height: number};
  skipState(): {readonly allowed: boolean; readonly command: boolean; readonly control: boolean};
  /** c7260(script, 1, tag, message): the script owner reports and the tag returns. */
  reportTagError?(tag: AsbTag, message: Uint8Array): void;
}

/** The save-object command registry services a graphics backend forwards. */
export type ArtemisLayerRegistryServices = Pick<
  ArtemisLayerHost<object>,
  'clearLayerCommands' | 'resetLayerCommands' | 'recordLayerProperties' | 'appendLayerCommand'
>;

/** A message layer's text resource and the retain/release of its loans. */
export interface ArtemisMessageActorOwner<M> {
  retain(message: M): void;
  release(message: M): void;
}

export interface ArtemisLayerOwnerHost<T extends object, I extends ArtemisImageDimensions, M> {
  /** The actor backend (image graphics, or a geometry-only diagnostic owner). */
  createGraphics(registry: ArtemisLayerRegistryServices): ArtemisLayerHost<T, I>;
  readonly images: ArtemisImageSource<I>;
  readonly runMode: ArtemisLayerRunModeHost;
  /** Stage loader for transition rule images. */
  loadRule(path: string): Promise<ArtemisRuleImage | null>;
  /** A message-layer actor (CLinkableTextLayer wrapper) holding a loan of `message`. */
  createMessageActor(message: M, owner: ArtemisMessageActorOwner<M>): T;
  /** Per-frame layer tween values: inner actor properties without a command record. */
  applyTweenProperties(id: string, actor: T, patch: ArtemisLayerPropertyPatch): void;
  /** The video decoder a video actor holds. */
  videoOf(actor: T): ArtemisTheoraVideo | undefined;
  /** The CEmoteLayer of an E-mote actor (dynamic cast 0x1401566e0). */
  emoteOf?(actor: T): ArtemisEmoteLayer | undefined;
  /** The CLayer display state of an actor; without it actors expose `properties`. */
  displayOf?(actor: T): ArtemisDisplayObject;
  /** The fields `var system=get_layer_info` reads from an actor. */
  layerInfo?(actor: T): ArtemisLayerInfo;
  /** Transition presentation state the renderer reads. */
  setCrossfade?(value: number): void;
  setVague?(value: number): void;
  setRuleThreshold?(value: number): void;
  /** Diagnostic records of stage, transition and tween effects. */
  trace?(effect: {readonly kind: string} & Record<string, unknown>): void;
}

export interface ArtemisStagePresentation {
  readonly state: number;
  readonly crossfade: number;
  readonly vague: number;
  readonly threshold: number;
  readonly rule: ArtemisRuleBitmap | null;
  readonly ruleRevision: number;
}

/** The stage's layer system: the layer tree (`ArtemisLayers`), the save object's layer
 * command registry (+0x68), layer events, the stage (flip/commit), `trans` and the tween
 * registry with layer tweens, over an actor backend. */
export class ArtemisLayerOwner<
  T extends object,
  I extends ArtemisImageDimensions = TriangleImage,
  M = unknown,
> {
  readonly layers: ArtemisLayers<T, I>;
  readonly commands: ArtemisLayerCommands;
  readonly tweenRegistry: ArtemisTweenRegistry;
  readonly graphics: ArtemisLayerHost<T, I>;
  private readonly slots = new WeakMap<T, ArtemisLayerEventSlots>();
  private readonly events: ArtemisLayerEvents<T>;
  private readonly stage: ArtemisStage;
  private readonly transition: ArtemisTransition;
  private readonly layerTweens: ArtemisLayerTweens<T>;
  private transitionState = 0;
  private refreshState = 0;
  private stageRule: ArtemisRuleBitmap | null = null;
  private tweenSync = false;
  private transitionTween: ArtemisTransitionTween | null = null;
  private crossfade = 0;
  private vague = 0;
  private threshold = 0;
  private ruleRevision = 0;

  constructor(
    hash: string,
    private readonly host: ArtemisLayerOwnerHost<T, I, M>,
  ) {
    artemisRevision(hash);
    const trace = (effect: {readonly kind: string} & Record<string, unknown>) =>
      host.trace?.(effect);
    const commands = (this.commands = new ArtemisLayerCommands(hash));
    const graphics = (this.graphics = host.createGraphics({
      clearLayerCommands: (ids) => commands.clear(ids),
      resetLayerCommands: (id, tag) => commands.reset(id, tag),
      // lyprop (and lytween's synthesized end state) outside replay: coalescing record b9cd0.
      recordLayerProperties: (tag) => commands.record(tag),
      appendLayerCommand: (id, tag) => commands.append(id, tag),
    }));
    // Actor copies carry their event slots (CArtemisLayer +0x100). Every other member
    // delegates with the graphics owner as `this`, so its state (texture ids) stays single.
    const copyImageLayer = (old: T): T => {
      const actor = graphics.copyImageLayer(old);
      const slots = this.slots.get(old);
      if (slots) this.slots.set(actor, slots.copy());
      return actor;
    };
    const layerHost = new Proxy(graphics, {
      get: (target, key) => {
        if (key === 'copyImageLayer') return copyImageLayer;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ArtemisLayerHost<T, I>;
    const layers = (this.layers = new ArtemisLayers(hash, host.images, layerHost));
    this.events = new ArtemisLayerEvents(layers.scene, commands, {
      slots: (actor) => this.eventSlots(actor),
    });
    const stage = (this.stage = new ArtemisStage(hash, {
      captureMode: () => 0,
      transitionState: () => this.transitionState,
      clearTransitionRule: () => trace({kind: 'clearTransitionRule', simulation: true}),
      resetTransitionLayerValue: (value) =>
        trace({kind: 'resetTransitionValue', value, simulation: true}),
      setTransitionState: (value) => {
        this.transitionState = value;
      },
      markSceneDirty: () => trace({kind: 'sceneDirty', simulation: true}),
      commitLayers: () => layers.commit(),
      refreshState: () => this.refreshState,
      setRefreshState: (value) => {
        this.refreshState = value;
      },
    }));
    const runMode = host.runMode;
    this.transition = new ArtemisTransition(hash, {
      captureMode: () => 0,
      commit: () => stage.commit(),
      enterRunMode: (mode) => {
        trace({kind: 'runMode', mode, simulation: true});
        runMode.enter(mode);
      },
      releaseRunMode: () => {
        trace({kind: 'runModeRelease', simulation: true});
        runMode.release();
      },
      now: () => runMode.now(),
      setWaitStart: (ms) => runMode.setWaitStart(ms),
      skipState: () => runMode.skipState(),
      setTransitionState: (value) => {
        this.transitionState = value;
      },
      setCrossfade: (value) => {
        trace({kind: 'crossfade', value, simulation: true});
        this.crossfade = value;
        host.setCrossfade?.(value);
      },
      stageSize: () => runMode.stageSize(),
      loadRule: (path) => host.loadRule(path),
      setRuleImage: (image) => {
        this.stageRule = image;
        this.ruleRevision++;
        trace({kind: 'ruleImage', replaced: true});
      },
      ruleImage: () => {
        const {width, height} = runMode.stageSize();
        // Stage +0x50 is created with the stage at stage size, one gray byte per pixel.
        if (this.stageRule?.width !== width || this.stageRule?.height !== height)
          this.stageRule = {
            width,
            height,
            bytesPerPixel: 1,
            pixels: new Uint8Array(width * height),
          };
        // The caller tiles the rule into these pixels.
        this.ruleRevision++;
        trace({kind: 'ruleImage', replaced: false});
        return this.stageRule;
      },
      setVague: (value) => {
        this.vague = value;
        host.setVague?.(value);
      },
      setRuleThreshold: (value) => {
        this.threshold = value;
        host.setRuleThreshold?.(value);
      },
      registerTween: (tween) => {
        this.transitionTween = tween;
      },
      reportError: (tag, message) => {
        if (!runMode.reportTagError) throw Error('Unsupported Artemis trans error report');
        runMode.reportTagError(tag, message);
      },
    });
    const tweens = (this.tweenRegistry = new ArtemisTweenRegistry(hash));
    this.layerTweens = new ArtemisLayerTweens(hash, layers.scene, tweens, commands, {
      applyImageProperties: (id, actor, patch) => host.applyTweenProperties(id, actor, patch),
      layerNotFound: (tag) => graphics.layerNotFound(tag),
      enterRunMode: (mode) => {
        trace({kind: 'runMode', mode, simulation: true});
        this.tweenSync = true;
        runMode.enter(mode);
      },
      endSyncWait: () => {
        trace({kind: 'tweenSyncEnd', simulation: true});
        this.tweenSync = false;
        // b5be0: c74 = c70, c70 = 0.
        runMode.enter(0);
      },
      deleteLayer: (tag, recordHistory) => {
        trace({kind: 'tweenDelete', id: tag.args.get('id'), simulation: true});
        layers.deleteLayer(tag.args.get('id') ?? '', recordHistory);
      },
      emitEvent: (tag) => {
        trace({kind: 'tweenEvent', id: tag.args.get('id'), simulation: true});
        runMode.emit(tag);
      },
      recordLayerProperties: (tag) => graphics.recordLayerProperties(tag),
    });
  }
  /** The transition state the presenter draws: state 1 crossfades from the previous frame
   * by `crossfade`, state 2 reveals by the stage rule against `threshold` and `vague`.
   * `ruleRevision` changes whenever the rule pixels may have. */
  get presentation(): ArtemisStagePresentation {
    return {
      state: this.transitionState,
      crossfade: this.crossfade,
      vague: this.vague,
      threshold: this.threshold,
      rule: this.stageRule,
      ruleRevision: this.ruleRevision,
    };
  }
  /** Event state of an actor (CArtemisLayer +0x100). */
  eventSlots(actor: T): ArtemisLayerEventSlots {
    let slots = this.slots.get(actor);
    if (!slots) this.slots.set(actor, (slots = new ArtemisLayerEventSlots()));
    return slots;
  }
  /** Steps every registered layer tween and updates every video layer's decoder. */
  tickTweens(now: number): void {
    this.tweenRegistry.tick(now);
    const videos = new Set<ArtemisTheoraVideo>();
    for (const view of ['current', 'retained'] as const)
      for (const entry of this.layers.scene.entries(view)) {
        const video = entry.value && this.host.videoOf(entry.value);
        if (video) videos.add(video);
      }
    for (const video of videos) video.update(now);
  }
  /** Diagnostic: each current video layer's decoder frame counters and picture revision. */
  get videoLayers(): {
    readonly id: string;
    readonly decoded: number;
    readonly target: number;
    readonly revision: number;
    readonly playing: boolean;
  }[] {
    const layers = [];
    for (const entry of this.layers.scene.entries('current')) {
      const video = entry.value && this.host.videoOf(entry.value);
      if (video)
        layers.push({
          id: entry.id,
          ...video.frame,
          revision: video.revision,
          playing: video.playing,
        });
    }
    return layers;
  }
  /** `wait video=` frame check: layer `id` is a video layer that is still playing. */
  videoPlaying(id: string): boolean {
    const actor = this.layers.scene.entry(id)?.value;
    return (actor !== undefined && this.host.videoOf(actor)?.playing) === true;
  }
  /** A `sync` layer tween holds run mode 4. */
  get tweenSyncPending(): boolean {
    return this.tweenSync;
  }
  dispatchTween(tag: AsbTag, recordHistory = true): boolean {
    this.host.trace?.({kind: 'tween', name: tag.name, id: tag.args.get('id'), simulation: true});
    return this.layerTweens.dispatch(tag, recordHistory);
  }
  hasLayer(id: string): boolean {
    return !!this.layers.scene.entry(id);
  }
  /** `var system=get_layer_info`: the current actor of layer `id`, undefined without one. */
  layerInfo(id: string): ArtemisLayerInfo | undefined {
    const actor = this.layers.scene.entry(id)?.value;
    if (actor === undefined) return undefined;
    if (!this.host.layerInfo) throw new Error('Unsupported Artemis layer info owner');
    return this.host.layerInfo(actor);
  }
  /** The registered transition tween is still running. */
  get transitionPending(): boolean {
    return !!this.transitionTween && !this.transitionTween.done;
  }
  /** Steps the transition tween to `now`. */
  tickTransition(now: number): void {
    if (this.transitionPending) this.transitionTween!.tick(now);
  }
  /** Runs the pending transition tween from `start` (nonzero uint32) to its natural end
   * and returns the end tick. */
  finishTransition(start: number): number {
    const tween = this.transitionTween;
    if (!tween || tween.done || !start) throw Error('No pending Artemis transition');
    const end = (start + tween.milliseconds) >>> 0;
    tween.tick(start);
    tween.tick(end);
    return end;
  }
  /** Attaches a message layer's actor at `name` (stage message-layer wrapper). */
  /** `createEmoteLayer` (Rev.3258 0x140151480): the layer set's insertion +0x168 of a new
   * E-mote actor at `id`, replacing any node there. Command registrations are untouched. */
  createEmoteLayer(id: string, emote: ArtemisEmoteLayer): void {
    if (!this.graphics.createEmoteLayer) throw Error('Unsupported Artemis E-mote layer owner');
    if (!this.layers.attachActor(id, this.graphics.createEmoteLayer(emote)))
      throw Error('Unsupported Artemis E-mote layer under an image layer: ' + id);
    this.host.trace?.({kind: 'emoteLayer', id, width: emote.width, height: emote.height});
  }
  /** `getEmoteLayer` lookup (+0x140) of `id` and the cast of its current actor: undefined
   * without the layer, null when it is not an E-mote layer. */
  emoteLayer(id: string): ArtemisEmoteLayer | null | undefined {
    const entry = this.layers.scene.entry(id);
    if (!entry) return undefined;
    return (entry.value !== undefined && this.host.emoteOf?.(entry.value)) || null;
  }
  /** The draw-time player advance (0x14001adf0) of every E-mote layer the retained
   * structure draws, each once. */
  drawEmoteLayers(now: number): void {
    const emotes = new Set<ArtemisEmoteLayer>();
    for (const entry of this.layers.scene.entries('retained')) {
      const emote = entry.value && this.host.emoteOf?.(entry.value);
      if (emote) emotes.add(emote);
    }
    for (const emote of emotes) emote.advance(now);
  }
  attachMessageActor(name: string, message: M, owner: ArtemisMessageActorOwner<M>): void {
    const actor = this.host.createMessageActor(message, owner);
    if (!this.layers.attachActor(name, actor))
      throw Error('Artemis message scene attachment blocked: ' + name);
    this.host.trace?.({kind: 'messageAttach', id: name, simulation: true});
  }
  detachMessageActor(name: string): void {
    this.layers.detachActor(name);
  }
  /** bf210 order: finish the registered transition tween, then replace the scene root. */
  reset(): void {
    this.transition.reset();
    if (this.transitionTween?.done) this.transitionTween = null;
    this.layers.reset();
    this.host.trace?.({kind: 'reset', simulation: true});
  }
  /** Save-object reset of the layer command registry. */
  clearLayerCommands(): void {
    this.commands.clearAll();
  }
  /** Save-object +0x68 layer command registry for the scenario save and load. */
  snapshotLayerCommands(): ReadonlyMap<string, readonly AsbTag[]> {
    return this.commands.snapshot();
  }
  restoreLayerCommands(snapshot: ReadonlyMap<string, readonly AsbTag[]>): void {
    this.commands.restore(snapshot);
  }
  /** Ids in native child order whose actor has an enabled `click` event and whose layer
   * and ancestors are visible. */
  clickableLayers(): string[] {
    return this.eventLayers('click');
  }
  /** Ids in native child order whose actor has an enabled event of `type` and whose layer
   * and ancestors are visible; `registered` also requires a stored callback. */
  eventLayers(type: ArtemisLayerEventType, registered = false): string[] {
    const scene = this.layers.scene;
    return scene
      .entries()
      .filter(({id, value}) => {
        const slots = value === undefined ? undefined : this.slots.get(value);
        return (
          !!slots?.isEnabled(type) &&
          (!registered || slots.callback(type) !== null) &&
          this.visible(id)
        );
      })
      .map(({id}) => id);
  }
  /** The layer and its ancestors are visible. */
  private visible(id: string): boolean {
    const parts = id.split('.');
    for (let length = 1; length <= parts.length; length++) {
      const value = this.layers.scene.entry(parts.slice(0, length).join('.'))?.value;
      if (value === undefined) continue;
      const properties = this.host.displayOf
        ? this.host.displayOf(value).properties
        : (value as {properties?: {visible?: boolean}}).properties;
      if (properties?.visible === false) return false;
    }
    return true;
  }
  /** The draggable setter (0x1400a4970) of layer `id`'s actor, when it exists. */
  setDraggable(id: string, draggable: boolean): void {
    const actor = this.layers.scene.entry(id)?.value;
    if (actor !== undefined) this.host.displayOf?.(actor).apply({draggable});
  }
  /** Invokes an actor's stored layer event callback. */
  invokeLayerEvent(id: string, type: ArtemisLayerEventType, sink: ArtemisLayerEventSink): boolean {
    const actor = this.layers.scene.entry(id)?.value;
    const slots = actor && this.slots.get(actor);
    if (!slots) throw Error('Artemis layer has no events: ' + id);
    if (!slots.isEnabled(type)) throw Error('Artemis layer event disabled: ' + id);
    return slots.invoke(type, sink);
  }
  /** The per-actor pointer update 0x140179f50 over every actor with a draggable flag or an
   * enabled click, rollover or rollout callback: hit layers first, topmost first, then the
   * rest in child order. With `inside` from the hit test, an actor raises `click` when inside,
   * not draggable and key 1 is decided; `rollover` when inside and previously outside;
   * `rollout` when outside and previously inside. An idle draggable actor under the pointer
   * starts on the key 1 down edge (`dragin`, 0x140179e80) and keeps the pointer and its
   * left/top; a dragging actor moves by the pointer offset since the start, clamped into its
   * drag area unless all four edges are zero, and raises `drag` while key 1 is down or
   * `dragout` and becomes idle. Moves set left/top without a command record. Returns the
   * raised events whose slot holds an enabled callback, in order. */
  updatePointer(
    pointer: {readonly x: number; readonly y: number},
    hits: readonly string[],
    keys: {readonly decide: boolean; readonly downEdge: boolean; readonly down: boolean},
  ): {readonly id: string; readonly type: ArtemisLayerEventType}[] {
    const events: {id: string; type: ArtemisLayerEventType}[] = [];
    const f = Math.fround;
    const hit = new Set(hits);
    const entries = this.layers.scene.entries();
    const order = [
      ...hits.flatMap((id) => entries.filter((entry) => entry.id === id)),
      ...entries.filter((entry) => !hit.has(entry.id)),
    ];
    for (const {id, value: actor} of order) {
      if (actor === undefined) continue;
      const slots = this.slots.get(actor);
      const display = this.host.displayOf?.(actor);
      const draggable = !!display?.draggable;
      const armed = (type: ArtemisLayerEventType) =>
        !!slots?.isEnabled(type) && slots.callback(type) !== null;
      if (!slots && !draggable) continue;
      if (!draggable && !armed('click') && !armed('rollover') && !armed('rollout')) continue;
      const state = this.eventSlots(actor);
      const raise = (type: ArtemisLayerEventType) => {
        if (armed(type)) events.push({id, type});
      };
      const inside = hit.has(id);
      if (inside && !draggable && keys.decide) raise('click');
      if (inside && !state.inside) raise('rollover');
      if (!inside && state.inside) raise('rollout');
      if (draggable && display) {
        const start = state.drag;
        if (!start) {
          if (inside && keys.downEdge) {
            raise('dragin');
            const {left, top} = display.properties;
            state.drag = {x: f(pointer.x), y: f(pointer.y), left, top};
          }
        } else {
          let x = f(start.left + f(f(pointer.x) - start.x)),
            y = f(start.top + f(f(pointer.y) - start.y));
          const area = display.dragArea;
          if (area.left || area.top || area.right || area.bottom) {
            x = Math.min(area.right, Math.max(area.left, x));
            y = Math.min(area.bottom, Math.max(area.top, y));
          }
          this.host.applyTweenProperties(id, actor, {left: x, top: y});
          if (keys.down) raise('drag');
          else {
            raise('dragout');
            state.drag = null;
          }
        }
      }
      state.inside = inside;
    }
    return events;
  }
  /** trans runs synchronously except rule loads, which return a promise. */
  dispatchTransition(tag: AsbTag): boolean | Promise<void> {
    return this.transition.dispatch(tag);
  }
  accepts(tag: AsbTag): boolean {
    return ['lyc', 'lyprop', 'lydel', 'flip', 'lyevent', 'anime', 'animedel', 'video'].includes(
      tag.name,
    );
  }
  /** `recordHistory` false is the native replay flag of the scenario loader. */
  dispatch(tag: AsbTag, recordHistory = true): Promise<boolean> {
    return tag.name === 'flip'
      ? Promise.resolve(this.stage.dispatch(tag))
      : tag.name === 'lyevent'
        ? Promise.resolve(this.events.dispatch(tag, !recordHistory))
        : this.layers.dispatch(tag, recordHistory);
  }
  close(): void {
    this.layers.close();
  }
}
