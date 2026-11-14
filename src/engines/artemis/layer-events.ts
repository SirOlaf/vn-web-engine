import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisLayerCommands} from './layer-commands.js';
import type {ArtemisScene} from './scene.js';

/** Event slot order of CLayer 0x1400a49c0/0x1400a4c60. */
export const ARTEMIS_LAYER_EVENT_TYPES = [
  'click',
  'rollover',
  'rollout',
  'dragin',
  'drag',
  'dragout',
] as const;
export type ArtemisLayerEventType = (typeof ARTEMIS_LAYER_EVENT_TYPES)[number];

/** Copy of the registering tag (CScriptBlock 0x1400c2400) with its pass-through flag. */
export interface ArtemisLayerEventCallback {
  readonly command: AsbTag;
  readonly penetration: boolean;
}

const copyTag = (tag: AsbTag): AsbTag => ({...tag, args: new Map(tag.args)});

/** b73e0 (ArtemisScriptEvents.emit). */
export interface ArtemisLayerEventSink {
  emit(command: AsbTag, mode: number, force: boolean): unknown;
}

/** A drag in progress: the pointer and the layer's left/top at its start. */
export interface ArtemisLayerDrag {
  readonly x: number;
  readonly y: number;
  readonly left: number;
  readonly top: number;
}

/** Per-actor event state of CLayer: six callbacks and enable bytes (+0x280..0x285, all
 * enabled by constructor 0x1400a3640), the pointer-inside flag of the last pointer update
 * (+0x286, initially clear) and the drag start (+0x288 pointer, -1,-1 when idle; +0x298
 * layer position). Actor copies (0x1400a4eb0) copy all of it. */
export class ArtemisLayerEventSlots {
  private readonly callbacks: (ArtemisLayerEventCallback | null)[] = Array(6).fill(null);
  private readonly enabled: boolean[] = Array(6).fill(true);
  inside = false;
  drag: ArtemisLayerDrag | null = null;
  callback(type: ArtemisLayerEventType): ArtemisLayerEventCallback | null {
    const callback = this.callbacks[ARTEMIS_LAYER_EVENT_TYPES.indexOf(type)];
    return callback ? {...callback, command: copyTag(callback.command)} : null;
  }
  isEnabled(type: ArtemisLayerEventType): boolean {
    return this.enabled[ARTEMIS_LAYER_EVENT_TYPES.indexOf(type)]!;
  }
  /** Virtual +0x100; null stores the empty callback used by mode=reset. */
  setCallback(type: number, callback: ArtemisLayerEventCallback | null): void {
    this.callbacks[type] = callback && {...callback, command: copyTag(callback.command)};
  }
  /** Virtual +0x108. */
  setEnabled(type: number, enabled: boolean): void {
    this.enabled[type] = enabled;
  }
  /** The stored functor (f8050/f8210) calls b73e0 with the tag copy, the type index as event
   * mode and the penetration flag as force: a click or rollover without penetration takes
   * its event latch, so later ones of the same pointer update are suppressed. Empty slots
   * do nothing. */
  invoke(type: ArtemisLayerEventType, sink: ArtemisLayerEventSink): boolean {
    const callback = this.callback(type);
    if (!callback) return false;
    sink.emit(callback.command, ARTEMIS_LAYER_EVENT_TYPES.indexOf(type), callback.penetration);
    return true;
  }
  copy(): ArtemisLayerEventSlots {
    const copy = new ArtemisLayerEventSlots();
    for (let type = 0; type < 6; type++) {
      copy.callbacks[type] = this.callbacks[type]!;
      copy.enabled[type] = this.enabled[type]!;
    }
    copy.inside = this.inside;
    copy.drag = this.drag;
    return copy;
  }
}

export interface ArtemisLayerEventHost<T> {
  /** Event state owned by an actor payload; actor copies must copy it. */
  slots(actor: T): ArtemisLayerEventSlots;
}

/** Native lyevent handler 0x1400d8a10. `replay` corresponds to its third argument, which
 * suppresses command-history maintenance. Pointer delivery belongs to the input owner.
 */
export class ArtemisLayerEvents<T> {
  constructor(
    private readonly scene: ArtemisScene<T>,
    private readonly commands: ArtemisLayerCommands,
    private readonly host: ArtemisLayerEventHost<T>,
  ) {}
  private actors(id: string): T[] {
    const actors = new Set<T>();
    for (const view of ['current', 'retained'] as const) {
      const value = this.scene.entry(id, view)?.value;
      if (value !== undefined) actors.add(value);
    }
    return [...actors];
  }
  /** CArtemisLayer +0x100 (0x1400b2f00): the node's actor in both structural views. */
  private setCallback(id: string, type: number, callback: ArtemisLayerEventCallback | null): void {
    const actors = this.actors(id);
    if (!actors.length) throw new Error('Unsupported Artemis layer event on an empty group');
    for (const actor of actors) this.host.slots(actor).setCallback(type, callback);
  }
  /** CArtemisLayer +0x108 (0x140112bd0): actors directly, groups recursively per child. */
  private setEnabled(id: string, type: number, enabled: boolean): void {
    const entry = this.scene.entry(id);
    if (!entry) return;
    if (!entry.acceptsChildren) {
      for (const actor of this.actors(id)) this.host.slots(actor).setEnabled(type, enabled);
      return;
    }
    for (const child of this.scene.select(id).slice(1))
      if (!child.acceptsChildren)
        for (const actor of this.actors(child.id)) this.host.slots(actor).setEnabled(type, enabled);
  }
  dispatch(tag: AsbTag, replay = false): boolean {
    if (tag.name !== 'lyevent') return false;
    const args = tag.args;
    const id = args.get('id') ?? '';
    // Layer set +0x140 lookup; an absent layer has no effect.
    const entry = this.scene.entry(id);
    if (!entry) return true;
    const type = (ARTEMIS_LAYER_EVENT_TYPES as readonly string[]).indexOf(args.get('type') ?? '');
    if (type < 0) return true;
    const mode = args.get('mode') ?? '';
    const actorNode = !entry.acceptsChildren;
    if (mode === 'init' || mode === 'reset') {
      if (mode === 'init') {
        const penetration =
          type >= 2 || (args.has('penetration') && args.get('penetration') !== '0');
        this.setCallback(id, type, {command: copyTag(tag), penetration});
      } else this.setCallback(id, type, null);
      if (actorNode) this.setEnabled(id, type, true);
      if (replay) return true;
      this.commands.erase(id, 'lyevent', new Map([['type', args.get('type')!]]));
      if (mode === 'init') this.commands.append(id, tag);
      return true;
    }
    if (mode === 'enable') {
      this.setEnabled(id, type, true);
      if (replay) return true;
      const keys = new Map([
        ['mode', 'disable'],
        ['type', args.get('type')!],
      ]);
      this.commands.erase(id, 'lyevent', keys);
      for (const descendant of this.descendants(id))
        this.commands.erase(descendant, 'lyevent', keys);
      return true;
    }
    if (mode === 'disable') {
      this.setEnabled(id, type, false);
      if (replay) return true;
      const equal = new Set(['mode', 'type']);
      this.commands.record(tag, equal);
      for (const descendant of this.descendants(id))
        this.commands.record({...tag, args: new Map(args).set('id', descendant)}, equal);
    }
    return true;
  }
  /** +0x1d8 enumeration: descendant ids spelled from the caller's id. */
  private descendants(id: string): string[] {
    return this.scene
      .select(id)
      .slice(1)
      .map((entry) => entry.id);
  }
}
