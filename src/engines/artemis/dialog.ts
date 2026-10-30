import type {TextDialogHost} from '../../platform/text-dialog.js';
import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisDialogEffects {
  blocked(): boolean;
  beginWait(): void;
  endWait(): void;
  writeVariable(name: string, value: string): void;
}
function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis dialog integer');
  return number;
}

/** The first `count` characters of `text` (0x1400a0560 in UTF-8 mode 2), up to a NUL. A
 * negative count never runs out. */
function leadingCharacters(text: string, count: number): string {
  const end = text.indexOf('\0');
  const characters = Array.from(end < 0 ? text : text.slice(0, end));
  return count < 0 ? characters.join('') : characters.slice(0, count).join('');
}

/** The UTF-8 `dialog` tag (0x1400c91e0) and its completion 0x1400b7460.
 *
 * `varname` makes the dialog cancellable and receives the result (1 accepted, 0 cancelled).
 * `textfield` adds a single-line field holding `message`; on either result its name receives
 * the field text, cut to `textfieldsize` characters when that is not 0. A revision with a
 * fixed dialog style never reads fontsize, minwidth or applydesktopscale. */
export class ArtemisDialog {
  private active: object | null = null;
  constructor(
    private readonly host: TextDialogHost,
    private readonly effects: ArtemisDialogEffects,
    private readonly fixedStyle = false,
  ) {}
  get pending(): boolean {
    return this.active !== null;
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'dialog') return false;
    if (this.effects.blocked()) return true;
    if (this.active) throw new Error('Artemis dialog is already pending');
    const p = tag.args;
    const field = p.get('textfield') ?? '';
    const fieldSize = p.has('textfieldsize') ? integer(p.get('textfieldsize')!) : 0;
    const request = Object.freeze({
      title: p.get('title') ?? '',
      message: p.get('message') ?? '',
      canCancel: p.has('varname'),
      fontSize: !this.fixedStyle && p.has('fontsize') ? integer(p.get('fontsize')!) : 20,
      minimumWidth: !this.fixedStyle && p.has('minwidth') ? integer(p.get('minwidth')!) : 240,
      applyDesktopScale:
        !this.fixedStyle && p.has('applydesktopscale') && p.get('applydesktopscale') !== '0',
      textField: p.has('textfield'),
      // CDialog ignores input for its first 500 ms (GetTickCount against the creation time).
      inputDelay: 500,
    });
    const variable = p.get('varname') ?? '';
    const token = {};
    this.active = token;
    try {
      this.effects.beginWait();
      this.host.present(request, (outcome) => {
        if (this.active !== token) throw new Error('Stale or repeated Artemis dialog completion');
        if (
          !Number.isInteger(outcome.result) ||
          outcome.result < -0x80000000 ||
          outcome.result > 0x7fffffff
        )
          throw new Error('Invalid Artemis dialog result');
        if (variable) this.effects.writeVariable(variable, String(outcome.result));
        if (field) {
          if (typeof outcome.text !== 'string') throw new Error('Artemis dialog text is missing');
          const text = fieldSize === 0 ? outcome.text : leadingCharacters(outcome.text, fieldSize);
          this.effects.writeVariable(field, text);
        }
        this.active = null;
        this.effects.endWait();
      });
    } catch (error) {
      if (this.active === token) {
        this.active = null;
        this.effects.endWait();
      }
      throw error;
    }
    return true;
  }
}
