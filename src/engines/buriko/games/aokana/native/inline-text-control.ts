import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaInlineTextState} from './inline-text-state.js';
import {AokanaBrowserMainWindow} from './browser-main-window.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaEngineDialogs} from './engine-dialogs.js';
import {AokanaWindowMessages, type AokanaWindowMessage} from './window-messages.js';
import {AokanaKeyboardMessages} from './keyboard-messages.js';
import {aokanaDisplayScaleSize, aokanaDisplayTransformRectangle} from './display-geometry.js';
import {terminatedNativeBytes} from './program-files.js';
import {writeText} from './text.js';

type EditElement = HTMLInputElement | HTMLTextAreaElement;
interface EditControl {
  readonly target: number;
  readonly frame: HTMLElement;
  readonly element: EditElement;
  fontCss: string;
  nativeText: string;
  viewText: string;
  readonly multiline: boolean;
}

/** Native Unicode EDIT subclass/lifetime over the Chromium form-control platform profile.
 * Browser selection, clipboard, composition and undo primitives remain the actual control's;
 * the title's WM_CHAR policy, visibility, focus and native string conversion stay explicit. */
export class AokanaInlineTextControl {
  readonly state = new AokanaInlineTextState();
  private control: EditControl | null = null;
  private keyboardPaste = false;
  constructor(
    readonly host: AokanaBrowserMainWindow,
    readonly fonts: AokanaNativeFonts,
    readonly dialogs: AokanaEngineDialogs,
    readonly messages: AokanaWindowMessages,
    readonly keyboard: AokanaKeyboardMessages,
  ) {}

  get element(): EditElement | null {
    return this.control?.element ?? null;
  }

  get target(): number | null {
    return this.control?.target ?? null;
  }

  private viewText(value: string): string {
    return this.control?.multiline
      ? value.replace(/\r\n?|\n/g, '\n')
      : value.replace(/[\r\n]/g, '');
  }

  /** HTML textareas expose LF offsets, while the Unicode EDIT uses UTF-16 CRLF offsets. */
  private nativeOffset(viewOffset: number): number {
    const control = this.control!;
    if (viewOffset <= 0) return 0;
    let at = 0;
    for (let index = 0; index < control.nativeText.length; index++) {
      const character = control.nativeText[index];
      if (character === '\r' && control.nativeText[index + 1] === '\n') index++;
      if (control.multiline || (character !== '\r' && character !== '\n')) at++;
      if (at >= viewOffset) return index + 1;
    }
    return control.nativeText.length;
  }

  /** Preserve the original native line endings until the actual browser edit changes them. */
  private synchronizeText(): void {
    const control = this.control;
    if (control === null || control.element.value === control.viewText) return;
    const previous = control.viewText,
      next = control.element.value;
    let first = 0,
      last = 0;
    while (first < previous.length && first < next.length && previous[first] === next[first])
      first++;
    while (
      last < previous.length - first &&
      last < next.length - first &&
      previous[previous.length - 1 - last] === next[next.length - 1 - last]
    )
      last++;
    const start = this.nativeOffset(first),
      end = this.nativeOffset(previous.length - last);
    control.nativeText =
      control.nativeText.slice(0, start) +
      next.slice(first, next.length - last).replace(/\n/g, '\r\n') +
      control.nativeText.slice(end);
    control.viewText = next;
  }

  private setText(value: string): void {
    const control = this.control!;
    control.nativeText = value.split('\0')[0]!;
    control.element.value = control.nativeText;
    control.viewText = control.element.value;
  }

  private selection(): readonly [number, number] {
    this.synchronizeText();
    const element = this.control!.element;
    return [
      this.nativeOffset(element.selectionStart ?? 0),
      this.nativeOffset(element.selectionEnd ?? 0),
    ];
  }

  private select(start: number, end: number): void {
    const control = this.control!;
    control.element.setSelectionRange(
      this.viewText(control.nativeText.slice(0, Math.min(start, end))).length,
      this.viewText(control.nativeText.slice(0, Math.max(start, end))).length,
      start > end ? 'backward' : 'forward',
    );
  }

  /** The native EDIT user limit is separate from the title's WM_CHAR width check. */
  private replaceSelection(value: string, start?: number, end?: number): void {
    const control = this.control!;
    const selected = this.selection();
    start ??= selected[0];
    end ??= selected[1];
    value = value.split('\0')[0]!;
    if (!control.multiline) value = value.split(/[\r\n]/)[0]!;
    const available = Math.max(0, 32767 - control.nativeText.length + end - start);
    value = value.slice(0, available);
    const next = control.nativeText.slice(0, start) + value + control.nativeText.slice(end);
    const viewStart = this.viewText(control.nativeText.slice(0, start)).length,
      viewEnd = this.viewText(control.nativeText.slice(0, end)).length;
    control.element.setRangeText(this.viewText(value), viewStart, viewEnd, 'end');
    control.nativeText = next;
    control.viewText = control.element.value;
    this.invalidate();
  }

  private async clipboardText(): Promise<string | null> {
    try {
      return await this.host.document.defaultView!.navigator.clipboard.readText();
    } catch {
      // OpenClipboard/GetClipboardData failure forwards a paste with no available text.
      return null;
    }
  }

  private async copySelection(cut: boolean): Promise<void> {
    const control = this.control!,
      [start, end] = this.selection();
    if (start === end) return;
    try {
      await this.host.document.defaultView!.navigator.clipboard.writeText(
        control.nativeText.slice(start, end),
      );
    } catch {
      return;
    }
    if (cut && this.control === control) this.replaceSelection('', start, end);
  }

  private adjacent(position: number, direction: -1 | 1, word: boolean): number {
    const value = this.control!.nativeText;
    const segments = new Intl.Segmenter(undefined, {granularity: word ? 'word' : 'grapheme'});
    let previous = 0;
    for (const segment of segments.segment(value)) {
      if (word && !segment.isWordLike) continue;
      if (direction === 1 && segment.index > position) return segment.index;
      if (direction === -1 && segment.index >= position) return previous;
      previous = segment.index;
    }
    return direction === -1 ? previous : value.length;
  }

  /** Physical navigation already ran in the browser. These numeric, non-pointer messages
   * explicitly target the same selection for PostMessage callers in the host profile. */
  private navigate(key: number): boolean {
    const control = this.control!,
      [start, end] = this.selection();
    const shifted = (this.messages.input.keyboardState[0x10]! & 0x80) !== 0,
      word = (this.messages.input.keyboardState[0x11]! & 0x80) !== 0;
    const reverse = control.element.selectionDirection === 'backward';
    const caret = reverse ? start : end,
      anchor = reverse ? end : start;
    let next: number;
    if (key === 0x41 && word) {
      this.select(0, control.nativeText.length);
      return true;
    }
    if (key === 0x2e) {
      this.replaceSelection('', start, start === end ? this.adjacent(end, 1, word) : end);
      return true;
    }
    if (key === 0x25 || key === 0x27) {
      const direction = key === 0x25 ? -1 : 1;
      next =
        !shifted && start !== end
          ? direction === -1
            ? start
            : end
          : this.adjacent(caret, direction, word);
    } else if (key === 0x24) {
      next =
        word || !control.multiline || caret === 0
          ? 0
          : control.nativeText.lastIndexOf('\n', caret - 1) + 1;
    } else if (key === 0x23) {
      const line = control.nativeText.indexOf('\n', caret);
      next = word || !control.multiline || line < 0 ? control.nativeText.length : line;
      if (
        !word &&
        control.multiline &&
        line >= 0 &&
        next > 0 &&
        control.nativeText[next - 1] === '\r'
      )
        next--;
    } else return false;
    this.select(shifted ? anchor : next, next);
    return true;
  }

  private invalidate(): void {
    if (this.control !== null) this.messages.invalidate(this.control.target);
  }

  async create(
    x: number,
    y: number,
    width: number,
    height: number,
    font: number,
    size: number,
    limit: number,
    focus: number,
  ): Promise<number> {
    const specification = this.state.specification(
      this.host.display,
      this.fonts,
      x,
      y,
      width,
      height,
      font,
      size,
      limit,
      focus,
    );
    if (specification.result !== 0) return specification.result;
    const spec = specification.value;
    this.close();
    this.dialogs.transition(true);
    const document = this.host.document,
      frame = document.createElement('div');
    const element: EditElement = spec.multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    if (!spec.multiline) (element as HTMLInputElement).type = 'text';
    element.setAttribute('aria-label', 'Text input');
    element.spellcheck = false;
    element.autocomplete = 'off';
    // b8b30 does not send EM_SETLIMITTEXT. The Unicode EDIT default is 32,767 TCHARs.
    element.maxLength = 32767;
    element.style.cssText =
      'display:block;border:0;outline:0;margin:0;padding:0;box-sizing:border-box;resize:none;background:transparent;overflow:hidden;transform-origin:top left;font-kerning:none';
    element.style.textAlign = ['left', 'center', 'right'][this.state.alignment]!;
    frame.style.cssText = 'position:absolute;overflow:hidden';
    frame.hidden = true;
    frame.append(element);
    this.host.parent.append(frame);
    const target = this.messages.createTarget();
    this.control = {
      target,
      frame,
      element,
      fontCss: '',
      nativeText: '',
      viewText: '',
      multiline: spec.multiline,
    };
    this.messages.bindQueuedNumericTarget(target, (message) => this.handleMessage(message));
    this.show(1);
    const [left, top, right, bottom] = aokanaDisplayTransformRectangle(this.host.display, [
      x,
      y,
      (x + width) | 0,
      (y + height) | 0,
    ]);
    const nativeWidth = (right - left) | 0,
      nativeHeight = (bottom - top) | 0;
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;
    frame.style.width = `${nativeWidth}px`;
    frame.style.height = `${nativeHeight}px`;
    const logicalFontWidth = Math.trunc(Math.imul(this.state.widthPercent, size) / 100) | 0;
    const [fontWidth, fontHeight] = aokanaDisplayScaleSize(
      this.host.display,
      logicalFontWidth,
      size,
    );
    const charset = await this.fonts.charset(spec.font);
    const face = await this.fonts.browser.create({
      face: this.fonts.text.decodeAuto({bytes: terminatedNativeBytes(spec.font), offset: 0}),
      height: fontHeight | 0,
      width: fontWidth >>> 1,
      weight: 100,
      italic: false,
      charset,
      pitchAndFamily: 1,
    });
    const cssFamily =
      face.cssFamily === 'sans-serif' ? face.cssFamily : JSON.stringify(face.cssFamily);
    this.control.fontCss = `100 ${face.emSize}px ${cssFamily}`;
    element.style.font = this.control.fontCss;
    element.style.lineHeight = `${fontHeight}px`;
    element.style.width = `${nativeWidth / face.horizontalScale}px`;
    element.style.height = `${nativeHeight}px`;
    element.style.transform = `scaleX(${face.horizontalScale})`;
    this.applyColor();
    this.state.limit = limit | 0;
    this.setText(this.fonts.text.decodeAuto({bytes: this.state.initial, offset: 0}));
    element.setSelectionRange(0, element.value.length);
    if (focus !== 0) element.focus();
    else this.host.focus();
    this.state.rectangle = spec.nativeRectangle;
    element.addEventListener('keydown', (raw) => {
      const event = raw as KeyboardEvent;
      this.keyboard.post(target, event);
      this.keyboardPaste = event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey);
      if (event.key === 'Tab') {
        this.show(0);
        event.preventDefault();
        this.host.focus();
      } else if (event.key === 'Enter') {
        this.character(13);
        event.preventDefault();
      }
      this.invalidate();
    });
    element.addEventListener('keyup', (event) =>
      this.keyboard.post(target, event as KeyboardEvent),
    );
    element.addEventListener('paste', (raw) => {
      const event = raw as ClipboardEvent;
      if (
        this.keyboardPaste &&
        this.character(0x16, event.clipboardData?.getData('text/plain') ?? null) === 'consume'
      )
        event.preventDefault();
      this.keyboardPaste = false;
    });
    element.addEventListener('beforeinput', (raw) => {
      const event = raw as InputEvent;
      // IME composition and direct paste are forwarded to the browser control, as messages
      // outside WM_CHAR are forwarded to the saved EDIT procedure in the native subclass.
      if (event.inputType !== 'insertText' || event.data === null || event.isComposing) return;
      const [start, end] = this.selection(),
        value = this.control!.nativeText;
      let next = value,
        at = start,
        accepted = '';
      for (let index = 0; index < event.data.length; index++) {
        const character = event.data.charCodeAt(index);
        const result = this.state.character(character, next, at, accepted.length === 0 ? end : at);
        if (result !== 'default') continue;
        const unit = event.data[index]!;
        next = next.slice(0, at) + unit + next.slice(accepted.length === 0 ? end : at);
        accepted += unit;
        at++;
      }
      if (accepted !== event.data) {
        event.preventDefault();
        if (accepted !== '') this.replaceSelection(accepted, start, end);
      }
    });
    for (const event of ['input', 'pointerdown', 'compositionend'])
      element.addEventListener(event, () => {
        this.synchronizeText();
        this.invalidate();
      });
    this.invalidate();
    return 0;
  }

  show(value: number): void {
    if (this.control === null) return;
    this.control.frame.hidden = value === 0;
    this.control.element.style.font = value === 0 ? '' : this.control.fontCss;
    this.state.visible = value | 0;
  }
  applyColor(): void {
    if (this.control === null) return;
    const bgr = this.state.textColorBgr;
    const rgb = ((bgr & 255) << 16) | (bgr & 0xff00) | ((bgr >>> 16) & 255);
    this.control.element.style.color = `#${rgb.toString(16).padStart(6, '0')}`;
  }
  close(): 0 {
    if (this.control !== null) {
      this.show(0);
      this.messages.forgetTarget(this.control.target);
      this.control.frame.remove();
      this.control = null;
      this.dialogs.transition(false);
    }
    return 0;
  }
  read(output: AokanaBpPointer | null): number {
    if (this.control === null) return -1;
    this.synchronizeText();
    const value = this.control.nativeText.split('\0')[0]!.slice(0, 1023);
    // EncodeWide accepts null for a byte-length query. This wrapper returns WCHAR count.
    if (output !== null) writeText(output, this.fonts.text.encodeWide(value, -1));
    return value.length;
  }

  character(
    value: number | bigint,
    clipboard: string | null = null,
  ): 'consume' | 'default' | 'submit' {
    if (this.control === null) return 'default';
    const element = this.control.element,
      [start, end] = this.selection();
    const result = this.state.character(value, this.control.nativeText, start, end, clipboard);
    if (result === 'submit') {
      element.setSelectionRange(0, element.value.length);
      this.host.focus();
      if (this.state.hideOnReturn !== 0) this.show(0);
    }
    return result;
  }

  /** The runtime routes this HWND's keyboard/paint messages before the main-window procedure. */
  async handleMessage(message: AokanaWindowMessage): Promise<boolean> {
    if (this.control === null || message.target !== this.control.target) return false;
    const control = this.control;
    if (message.message === 0xf) {
      this.applyColor();
      this.host.invalidateInline(this.state.rectangle);
    } else if (message.message === 0x100) {
      if (BigInt(message.wParam) === 9n) this.show(0);
      this.invalidate();
      return (
        this.messages.isPhysical(message) ||
        BigInt(message.wParam) === 9n ||
        this.navigate(Number(BigInt.asUintN(32, BigInt(message.wParam))))
      );
    } else if (message.message === 0x201 || message.message === 0x282) this.invalidate();
    else if (message.message === 0x102) {
      const value = Number(BigInt.asUintN(16, BigInt(message.wParam)));
      const clipboard = BigInt(message.wParam) === 0x16n ? await this.clipboardText() : null;
      if (this.control !== control) return true;
      if (this.character(message.wParam, clipboard) === 'default') {
        if (value === 3 || value === 24) await this.copySelection(value === 24);
        else if (value === 8) {
          const [start, end] = this.selection();
          if (start !== end) this.replaceSelection('', start, end);
          else if (start > 0) {
            // The explicit Chromium control profile deletes one grapheme on backspace.
            this.replaceSelection('', this.adjacent(start, -1, false), end);
          }
        } else if (value === 0x16) {
          if (clipboard !== null) this.replaceSelection(clipboard);
        } else if (value >= 32) this.replaceSelection(String.fromCharCode(value));
      }
    } else if (message.message === 0x300 || message.message === 0x301)
      await this.copySelection(message.message === 0x300);
    else if (message.message === 0x302) {
      const value = await this.clipboardText();
      if (value !== null && this.control === control) this.replaceSelection(value);
    } else if (message.message === 0x303) this.replaceSelection('');
    else if (message.message === 0xb1) {
      this.synchronizeText();
      const start = Number(BigInt.asIntN(32, BigInt(message.wParam))),
        end = Number(BigInt.asIntN(32, BigInt(message.lParam)));
      if (start === -1) {
        const [, end] = this.selection();
        this.select(end, end);
      } else this.select(Math.max(0, start), end < 0 ? this.control.nativeText.length : end);
    } else return false;
    return true;
  }
}
