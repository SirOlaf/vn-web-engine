import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisModeEffects {
  writeStatus(name: string, value: string): void;
  commandSkipChanged(active: boolean): void;
  controlSkipChanged(active: boolean): void;
  /** b7810 after the status write: the indicator layer of the current message layer's
   * entry, the automode deadline of a flagless wait (off) and the in/out event. */
  automodeChanged(active: boolean, indicator: Readonly<ArtemisAutomodeLayer>): void;
  releaseScheduler(): void;
  /** Script +0x35e0: the current message layer name. */
  currentMessageLayer(): string;
}

/** CIconInfo: `present` is byte +8, `name` the string +0x10 (kept when `present` clears). */
export interface ArtemisAutomodeLayer {
  present: boolean;
  name: string;
}

/** Mode fields of the scenario archive (kind 'S'), named as in `ArtemisScenarioRecord`. */
export interface ArtemisModeSaveFields {
  readonly automodeAllowed: boolean;
  readonly automode: boolean;
  readonly automodeLayers: ReadonlyMap<string, Readonly<ArtemisAutomodeLayer>>;
  readonly skipAllowed: boolean;
  readonly commandSkip: boolean;
  readonly controlSkip: boolean;
  readonly alreadyRead: boolean;
  readonly rightClickAllowed: boolean;
  readonly rightClickScript: string;
  readonly autosave: number;
  readonly stopAutoByClick: boolean;
  readonly stopAutoByStop: boolean;
  readonly syncSe: readonly string[];
  readonly skipUnread: boolean;
  readonly writeBacklog: boolean;
}

/** Rev.3179 mode command state. Rendering/input effects remain supplied platform services. */
export class ArtemisModes {
  /** Constructor bytes b60/37f0 enable these flags; history collection has a separate owner. */
  alreadyReadEnabled = true;
  /** Byte b61: `s.status.alreadyread` was last written 1 by the read check. */
  alreadyReadStatus = false;
  writeBacklog = true;
  /** Constructor/bf210: request dword cc8 = 0 (allow byte ccb), cd0 = "rclick.iet". */
  rightClickAllowed = false;
  rightClickScript = 'rclick.iet';
  skipAllowed = true;
  skipUnread = false;
  commandSkip = false;
  controlSkip = false;
  /** Constructor dword +0x30 = 0 leaves automode disallowed (byte +0x32) until [automode]. */
  automodeAllowed = false;
  automode = false;
  /** +0x38: automode indicator layer per message layer (find-or-create in `automode`). */
  readonly automodeLayers = new Map<string, ArtemisAutomodeLayer>();
  /** Constructor/bf210 word 3594 = 0x101. */
  stopAutoByClick = true;
  stopAutoByStop = true;
  syncSe: string[] = [];
  autosave: 0 | 1 | 2 = 0;
  constructor(private readonly effects: ArtemisModeEffects) {}

  setCommandSkip(active: boolean, force = false): void {
    if ((active && !force && !this.skipAllowed) || active === this.commandSkip) return;
    this.commandSkip = active;
    this.effects.writeStatus('s.status.commandskip', active ? '1' : '0');
    this.effects.commandSkipChanged(active);
  }
  setControlSkip(active: boolean): void {
    if ((active && !this.skipAllowed) || active === this.controlSkip) return;
    this.controlSkip = active;
    this.effects.writeStatus('s.status.controlskip', active ? '1' : '0');
    this.effects.controlSkipChanged(active);
  }
  /** The read check of 0x1400c0560 before a caret tag runs: a read tag writes
   * `s.status.alreadyread` 1 once; an unread tag ends command skip unless skip of unread
   * text is on (b7ba0 with force 0), then `markUnread` follows if the caret still has a
   * file. */
  readTag(read: boolean): void {
    if (read) {
      if (!this.alreadyReadStatus) {
        this.effects.writeStatus('s.status.alreadyread', '1');
        this.alreadyReadStatus = true;
      }
    } else if (!this.skipUnread) this.setCommandSkip(false);
  }
  /** The unread tag is marked; a set status latch writes `s.status.alreadyread` 0. */
  markUnread(): void {
    if (!this.alreadyReadStatus) return;
    this.effects.writeStatus('s.status.alreadyread', '0');
    this.alreadyReadStatus = false;
  }
  /** 0x1400b7810. The indicator entry is found or created (0x1400ebf10) before the
   * status write. */
  setAutomode(active: boolean, force = false): void {
    if ((active && !force && !this.automodeAllowed) || active === this.automode) return;
    this.automode = active;
    const indicator = this.automodeLayer();
    this.effects.writeStatus('s.status.automode', active ? '1' : '0');
    this.effects.automodeChanged(active, indicator);
  }
  /** 0x1400ebf10 on +0x38 with the current message layer +0x35e0: find or create. */
  private automodeLayer(): ArtemisAutomodeLayer {
    const owner = this.effects.currentMessageLayer();
    let entry = this.automodeLayers.get(owner);
    if (!entry) this.automodeLayers.set(owner, (entry = {present: false, name: ''}));
    return entry;
  }
  /** bf210 mode fields after automode off and scheduler release (owned by the reset caller).
   * skipUnread (35b0) and the command/control skip states are not reset. */
  reset(): void {
    this.automodeAllowed = false;
    this.skipAllowed = true;
    this.automodeLayers.clear();
    this.alreadyReadEnabled = true;
    this.alreadyReadStatus = false;
    this.rightClickAllowed = false;
    this.rightClickScript = 'rclick.iet';
    this.autosave = 0;
    this.stopAutoByClick = this.stopAutoByStop = true;
    this.syncSe = [];
    this.writeBacklog = true;
  }
  saveFields(): ArtemisModeSaveFields {
    return {
      automodeAllowed: this.automodeAllowed,
      automode: this.automode,
      automodeLayers: new Map([...this.automodeLayers].map(([key, value]) => [key, {...value}])),
      skipAllowed: this.skipAllowed,
      commandSkip: this.commandSkip,
      controlSkip: this.controlSkip,
      alreadyRead: this.alreadyReadEnabled,
      rightClickAllowed: this.rightClickAllowed,
      rightClickScript: this.rightClickScript,
      autosave: this.autosave,
      stopAutoByClick: this.stopAutoByClick,
      stopAutoByStop: this.stopAutoByStop,
      syncSe: [...this.syncSe],
      skipUnread: this.skipUnread,
      writeBacklog: this.writeBacklog,
    };
  }
  /** Loader section reads: present fields are assigned directly, without status writes or
   * effects (the loader's later 0x1400b7810/0x1400b7ba0/0x1400b7c70 calls are the host's). */
  loadFields(fields: Partial<ArtemisModeSaveFields>): void {
    if (
      fields.autosave !== undefined &&
      fields.autosave !== 0 &&
      fields.autosave !== 1 &&
      fields.autosave !== 2
    )
      throw Error('Unsupported Artemis saved autosave mode');
    if (fields.automodeAllowed !== undefined) this.automodeAllowed = fields.automodeAllowed;
    if (fields.automode !== undefined) this.automode = fields.automode;
    if (fields.automodeLayers) {
      this.automodeLayers.clear();
      for (const [key, value] of fields.automodeLayers) this.automodeLayers.set(key, {...value});
    }
    if (fields.skipAllowed !== undefined) this.skipAllowed = fields.skipAllowed;
    if (fields.commandSkip !== undefined) this.commandSkip = fields.commandSkip;
    if (fields.controlSkip !== undefined) this.controlSkip = fields.controlSkip;
    if (fields.alreadyRead !== undefined) this.alreadyReadEnabled = fields.alreadyRead;
    if (fields.rightClickAllowed !== undefined) this.rightClickAllowed = fields.rightClickAllowed;
    if (fields.rightClickScript !== undefined) this.rightClickScript = fields.rightClickScript;
    if (fields.autosave !== undefined) this.autosave = fields.autosave as 0 | 1 | 2;
    if (fields.stopAutoByClick !== undefined) this.stopAutoByClick = fields.stopAutoByClick;
    if (fields.stopAutoByStop !== undefined) this.stopAutoByStop = fields.stopAutoByStop;
    if (fields.syncSe) this.syncSe = [...fields.syncSe];
    if (fields.skipUnread !== undefined) this.skipUnread = fields.skipUnread;
    if (fields.writeBacklog !== undefined) this.writeBacklog = fields.writeBacklog;
  }
  /** Returns false for commands outside this mode service. */
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    switch (tag.name) {
      case 'alreadyread':
        this.alreadyReadEnabled = p.get('mode') !== '0';
        return true;
      case 'writebacklog':
        this.writeBacklog = p.has('mode') && p.get('mode') !== '0';
        return true;
      case 'rclick':
        this.rightClickAllowed = p.get('allow') !== '0';
        if (p.has('file')) this.rightClickScript = p.get('file')!;
        return true;
      case 'skip':
        if (p.get('allow') === '0') {
          this.setCommandSkip(false);
          this.setControlSkip(false);
          this.skipAllowed = false;
        } else this.skipAllowed = true;
        if (p.has('unread')) this.skipUnread = p.get('unread') !== '0';
        return true;
      case 'automode': {
        const entry = this.automodeLayer();
        entry.present = p.has('layer');
        if (entry.present) entry.name = p.get('layer')!;
        if (p.has('stopbyclick')) this.stopAutoByClick = p.get('stopbyclick') !== '0';
        if (p.has('stopbystop')) this.stopAutoByStop = p.get('stopbystop') !== '0';
        // 0x1400a0770 with delimiter ",": fields between delimiters, empty ones included,
        // so an empty value is one empty id. A comma is never a Shift_JIS trail byte.
        if (p.has('syncse')) this.syncSe = p.get('syncse')!.split('\0', 1)[0]!.split(',');
        if (p.get('allow') === '0') {
          this.setAutomode(false);
          this.effects.releaseScheduler();
          this.automodeAllowed = false;
        } else this.automodeAllowed = true;
        return true;
      }
      case 'autosave': {
        const allow = p.get('allow');
        if (allow === '0' || allow === '1' || allow === '2')
          this.autosave = Number(allow) as 0 | 1 | 2;
        return true;
      }
      default:
        return false;
    }
  }
}
