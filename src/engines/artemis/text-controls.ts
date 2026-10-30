import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisTextControlHost {
  currentMessageLayer(): string;
  messageLayerExists(id: string): boolean;
  /** 0x14014f490 mode=0 creates/selects the native message layer; owner supplies its graphics/text effects. */
  selectMessageLayer(id: string): void;
  /** Clear all native backlog collections, not only displayed text. */
  clearBacklog(): void;
}
export interface ArtemisBacklogLayer {
  readonly useOverride: boolean;
  readonly layer: string;
}

export interface ArtemisTextControlFields {
  readonly hideAllowed: boolean;
  readonly hiddenWindows: readonly string[];
  readonly backlogMessageLayer: string;
  readonly backlogIncludeFont: boolean;
  readonly backlogAllowed: boolean;
  readonly hiddenBacklogLayers: readonly string[];
  readonly backlogLayers: ReadonlyMap<string, ArtemisBacklogLayer>;
}

/** UTF-8 text configuration from 0x1400d4cb0 / 0x1400d4a10.
 * This configuration does not render backlog or implement message-hide input actions.
 */
export class ArtemisTextControls {
  backlogAllowed = false;
  backlogIncludeFont = true;
  backlogMessageLayer = 'backlog';
  hideAllowed = false;
  private hideWindows = new Set<string>();
  private backlogHiddenLayers = new Set<string>();
  private readonly backlogLayers = new Map<string, ArtemisBacklogLayer>();
  constructor(private readonly host: ArtemisTextControlHost) {}
  get hiddenWindows(): ReadonlySet<string> {
    return new Set(this.hideWindows);
  }
  get hiddenBacklogLayers(): ReadonlySet<string> {
    return new Set(this.backlogHiddenLayers);
  }
  backlogLayer(messageLayer: string): ArtemisBacklogLayer | undefined {
    return this.backlogLayers.get(messageLayer);
  }
  /** Scenario archive sections 0xf/0x10 (+0x37b8 hide allow, +0x37c0 hidden windows), 0x3e
   * (+0x37d0 backlog message layer), 0x3d (+0x37f1 include font), 0x11 (+0x37f2 backlog
   * allow), 0x25 (+0x37f8 hidden backlog layers) and 0x14 (+0x3808 per-layer override). */
  saveFields(): ArtemisTextControlFields {
    return {
      hideAllowed: this.hideAllowed,
      hiddenWindows: [...this.hideWindows],
      backlogMessageLayer: this.backlogMessageLayer,
      backlogIncludeFont: this.backlogIncludeFont,
      backlogAllowed: this.backlogAllowed,
      hiddenBacklogLayers: [...this.backlogHiddenLayers],
      backlogLayers: new Map(this.backlogLayers),
    };
  }
  /** Loader section reads: plain assignment of present sections. */
  loadFields(fields: Partial<ArtemisTextControlFields>): void {
    if (fields.hideAllowed !== undefined) this.hideAllowed = fields.hideAllowed;
    if (fields.hiddenWindows) this.hideWindows = new Set(fields.hiddenWindows);
    if (fields.backlogMessageLayer !== undefined)
      this.backlogMessageLayer = fields.backlogMessageLayer;
    if (fields.backlogIncludeFont !== undefined)
      this.backlogIncludeFont = fields.backlogIncludeFont;
    if (fields.backlogAllowed !== undefined) this.backlogAllowed = fields.backlogAllowed;
    if (fields.hiddenBacklogLayers) this.backlogHiddenLayers = new Set(fields.hiddenBacklogLayers);
    if (fields.backlogLayers) {
      this.backlogLayers.clear();
      for (const [name, layer] of fields.backlogLayers)
        this.backlogLayers.set(name, Object.freeze({...layer}));
    }
  }
  /** bf210 restores the constructor configuration (37b8..3808). */
  reset(): void {
    this.backlogAllowed = false;
    this.backlogIncludeFont = true;
    this.backlogMessageLayer = 'backlog';
    this.hideAllowed = false;
    this.hideWindows = new Set();
    this.backlogHiddenLayers = new Set();
    this.backlogLayers.clear();
  }
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    if (tag.name === 'hide') {
      this.hideAllowed = p.get('allow') !== '0';
      if (p.has('window')) this.hideWindows = new Set(p.get('window')!.split(','));
      return true;
    }
    if (tag.name !== 'backlog') return false;
    const current = this.host.currentMessageLayer();
    this.backlogAllowed = p.get('allow') !== '0';
    if (p.has('includefont')) this.backlogIncludeFont = p.get('includefont') !== '0';
    if (p.has('messagelayer')) {
      this.backlogMessageLayer = p.get('messagelayer')!;
      if (!this.host.messageLayerExists(this.backlogMessageLayer)) {
        this.host.selectMessageLayer(this.backlogMessageLayer);
        this.host.selectMessageLayer(current);
      }
    }
    const previous = this.backlogLayers.get(current);
    this.backlogLayers.set(
      current,
      Object.freeze({
        useOverride: p.has('layer'),
        // Native omitting layer resets its use flag but retains its prior string.
        layer: p.get('layer') ?? previous?.layer ?? '',
      }),
    );
    // Native delimiter splitting preserves empty elements and literal whitespace.
    if (p.has('hide')) this.backlogHiddenLayers = new Set(p.get('hide')!.split(','));
    if (p.has('clear') && p.get('clear') !== '0') this.host.clearBacklog();
    return true;
  }
}
