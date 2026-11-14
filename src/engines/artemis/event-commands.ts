import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';
import {emptyBlock} from './scenario-save.js';

const registrations = [
  'setonautomodein',
  'setonautomodeout',
  'setoncommandskipin',
  'setoncommandskipout',
  'setoncontrolskipin',
  'setoncontrolskipout',
  'setonhidein',
  'setonhideout',
  'setonbacklogin',
  'setonbacklogout',
  'setondirchg',
] as const;
export type ArtemisCommandEvent = (typeof registrations)[number];

/** Native 0x1400df0c0 captures the current file only for label-only registrations. */
export function captureEventCommand(tag: AsbTag, currentFile: () => string): AsbTag {
  const args = new Map(tag.args);
  if (!args.has('file') && args.has('label')) args.set('file', currentFile());
  return {...tag, args};
}

const copy = (tag: AsbTag): AsbTag => ({...tag, args: new Map(tag.args)});

export interface ArtemisEventCommandFields {
  readonly eventSlots: readonly AsbTag[];
  readonly dirchg: AsbTag;
  readonly windowButtons: ReadonlyMap<number, AsbTag>;
  readonly windowButton: AsbTag;
}

/** Copied native command events; delon* clears a slot. Mode/input owners determine when to
 * dispatch them.
 */
export class ArtemisEventCommands {
  private readonly commands = new Map<ArtemisCommandEvent, AsbTag>();
  private readonly windowButtons = new Map<number | null, AsbTag>();
  constructor(private readonly currentFile: () => string) {}
  /** bf210 empties the eleven seton* slots (38b0..3ce0); window buttons (3c70/3c80) remain. */
  reset(): void {
    this.commands.clear();
  }
  /** delon* (0x1400e0330) move-assigns an empty block (a2300), which c6730 skips. */
  dispatch(tag: AsbTag): boolean {
    if (tag.name === 'setonwindowbutton' || tag.name === 'delonwindowbutton') {
      // df0c0/e0330: atoi(button) keys map 3c70; without button the single slot 3c80.
      const button = tag.args.has('button') ? artemisInteger(tag.args.get('button')!) : null;
      if (tag.name === 'delonwindowbutton') this.windowButtons.delete(button);
      else this.windowButtons.set(button, captureEventCommand(tag, this.currentFile));
      return true;
    }
    if (tag.name.startsWith('delon')) {
      const event = 'seton' + tag.name.slice(5);
      if (!(registrations as readonly string[]).includes(event)) return false;
      this.commands.delete(event as ArtemisCommandEvent);
      return true;
    }
    if (!(registrations as readonly string[]).includes(tag.name)) return false;
    this.commands.set(tag.name as ArtemisCommandEvent, captureEventCommand(tag, this.currentFile));
    return true;
  }
  /** Window-button command for a numbered button, or the button-less slot for null. */
  windowButton(button: number | null): AsbTag | undefined {
    const command = this.windowButtons.get(button);
    return command ? {...command, args: new Map(command.args)} : undefined;
  }
  /** Scenario archive fields: sections 0x28..0x31 (+0x38b0..+0x3c10, the first ten
   * registrations in order), 0x21 (+0x3ce0 setondirchg), 0x53 (+0x3c70 numbered window
   * buttons) and 0x4d (+0x3c80 the button-less slot). Empty slots are empty blocks. */
  saveFields(): ArtemisEventCommandFields {
    const block = (tag: AsbTag | undefined) => (tag ? copy(tag) : emptyBlock);
    const buttons = new Map<number, AsbTag>();
    for (const [button, tag] of [...this.windowButtons].sort(([a], [b]) => (a ?? 0) - (b ?? 0)))
      if (button !== null) buttons.set(button, copy(tag));
    return {
      eventSlots: registrations.slice(0, 10).map((event) => block(this.commands.get(event))),
      dirchg: block(this.commands.get('setondirchg')),
      windowButtons: buttons,
      windowButton: block(this.windowButtons.get(null)),
    };
  }
  /** Loader section reads; an empty block (empty name) leaves the slot unset. Absent
   * sections keep the current slot. */
  loadFields(fields: Partial<ArtemisEventCommandFields>): void {
    const set = <K>(map: Map<K, AsbTag>, key: K, tag: AsbTag) => {
      if (tag.name) map.set(key, copy(tag));
      else map.delete(key);
    };
    fields.eventSlots?.forEach((tag, index) => set(this.commands, registrations[index]!, tag));
    if (fields.dirchg) set(this.commands, 'setondirchg', fields.dirchg);
    if (fields.windowButtons) {
      for (const button of [...this.windowButtons.keys()])
        if (button !== null) this.windowButtons.delete(button);
      for (const [button, tag] of fields.windowButtons) set(this.windowButtons, button, tag);
    }
    if (fields.windowButton) set(this.windowButtons, null, fields.windowButton);
  }
  command(event: ArtemisCommandEvent): AsbTag | undefined {
    const command = this.commands.get(event);
    return command ? {...command, args: new Map(command.args)} : undefined;
  }
}
