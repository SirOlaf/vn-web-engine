import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaNativeText, copyText, textBytes} from './text.js';
import {parseAokanaPropertyNumber} from './crt-numbers.js';
import {
  formatPropertyScalar,
  formatPropertySource,
  propertyEditCharacter,
  propertyEditDeleteAllowed,
  readPropertyWord,
  writePropertyWord,
  propertyTextPointer,
  type AokanaPropertySource,
} from './property-values.js';
import {AokanaWindowMessages, type AokanaWindowMessage} from './window-messages.js';

export interface AokanaPropertyRow {
  readonly name: string;
  readonly kind: number;
  value: number;
  rawCopy: Uint8Array;
  formatted: string;
  readonly source: AokanaPropertySource | null;
  readonly mutable: boolean;
  readonly editable: number;
  readonly refreshCallback: AokanaPropertyCallback | null;
  readonly refreshContext: unknown;
  readonly editCallback: AokanaPropertyCallback | null;
  readonly editContext: unknown;
}
export type AokanaPropertyCallback = (row: AokanaPropertyRow, context: unknown, mode: 0) => number;
interface PropertyTab {
  readonly name: string;
  readonly rows: AokanaPropertyRow[];
  selected: number;
}
interface PropertyEvent {
  readonly kind: number;
  readonly value: number;
}
interface PropertyRecord {
  readonly id: number;
  readonly target: number;
  readonly panel: HTMLElement;
  readonly tabsElement: HTMLElement;
  readonly rowsElement: HTMLElement;
  readonly buttonsElement: HTMLElement;
  readonly title: string;
  readonly columns: readonly [number, number];
  readonly tabs: PropertyTab[];
  readonly buttons: HTMLButtonElement[];
  readonly events: PropertyEvent[];
  readonly rowButtons: HTMLButtonElement[];
  displayedTab: number;
  uiSelected: number;
  selectedTab: number;
  closeRequested: boolean;
}
type Notification =
  | {kind: 'tab'; tab: number}
  | {kind: 'selection'; row: number}
  | {kind: 'edit'; row: number | null};

function offset(pointer: AokanaBpPointer | null, bytes: number): AokanaBpPointer | null {
  return pointer === null ? null : {bytes: pointer.bytes, offset: pointer.offset + bytes};
}

/** Concrete Aokana property windows, their native live-value records and queued control messages. */
export class AokanaPropertyEditors {
  private nextId = 0;
  private nextNotification = 0n;
  private readonly notifications = new Map<bigint, Notification>();
  private readonly records = new Map<number, PropertyRecord>();
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly text: AokanaNativeText,
    readonly messages: AokanaWindowMessages,
    readonly nativeWindowTitle: Uint8Array,
  ) {}

  /** 1400ac960 writes the tagged ID before map insertion, including its native OR collisions. */
  create(
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    subtitle: AokanaBpPointer | null,
    position: AokanaBpPointer | null,
    firstWidth: number,
    secondWidth: number,
  ): number {
    const panel = this.document.createElement('section');
    panel.setAttribute('role', 'dialog');
    panel.style.cssText =
      'position:fixed;z-index:30;background:Canvas;color:CanvasText;border:1px solid;padding:1rem;max-height:90vh;overflow:auto';
    this.parent.append(panel);
    const caption = this.text.decodeAuto(title ?? {bytes: this.nativeWindowTitle, offset: 0});
    const description = subtitle === null ? '' : this.text.decodeAuto(subtitle);
    const x = position === null ? 0 : readPropertyWord(position);
    const y = position === null ? 0 : readPropertyWord(offset(position, 4));
    this.nextId = (this.nextId + 1) >>> 0;
    const id = (this.nextId | 0xf8000001) >>> 0;
    writePropertyWord(output, id);
    if (this.records.has(id))
      throw new Error(
        'Aokana property ID collision leaves the newly shown HWND without its native record',
      );
    const heading = this.document.createElement('h2');
    heading.textContent = caption;
    const tabsElement = this.document.createElement('div');
    tabsElement.setAttribute('role', 'tablist');
    const rowsElement = this.document.createElement('div');
    rowsElement.setAttribute('role', 'listbox');
    rowsElement.style.cssText = 'overflow:auto;max-height:60vh;min-height:10rem';
    const columnHeader = this.document.createElement('div');
    columnHeader.style.display = 'flex';
    for (const [label, width] of [
      ['項目名', firstWidth],
      ['パラメータ', secondWidth],
    ] as const) {
      const cell = this.document.createElement('span');
      cell.textContent = label;
      cell.style.width = `${width | 0}px`;
      columnHeader.append(cell);
    }
    const buttonsElement = this.document.createElement('div');
    const descriptionElement = this.document.createElement('p');
    descriptionElement.textContent = description;
    descriptionElement.hidden = description.length === 0;
    panel.append(
      heading,
      tabsElement,
      columnHeader,
      rowsElement,
      descriptionElement,
      buttonsElement,
    );
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    const record: PropertyRecord = {
      id,
      target: this.messages.createTarget(),
      panel,
      tabsElement,
      rowsElement,
      buttonsElement,
      title: caption,
      columns: [firstWidth | 0, secondWidth | 0],
      tabs: [],
      buttons: [],
      events: [],
      selectedTab: 0,
      closeRequested: false,
      rowButtons: [],
      displayedTab: -1,
      uiSelected: -1,
    };
    this.records.set(id, record);
    // These native templates have no WS_SYSMENU; no additional browser close button is inserted.
    return 0;
  }

  /** 1400ac850 destroys the actual window before freeing its records and pending native events. */
  destroy(id: number): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    record.panel.remove();
    this.messages.forgetTarget(record.target);
    record.events.length = 0;
    record.tabs.length = 0;
    this.records.delete(id >>> 0);
    return 0;
  }

  getPosition(output: AokanaBpPointer | null, id: number): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    const rectangle = record.panel.getBoundingClientRect();
    writePropertyWord(output, Math.trunc(rectangle.left));
    writePropertyWord(offset(output, 4), Math.trunc(rectangle.top));
    return 0;
  }
  setPosition(id: number, position: AokanaBpPointer | null): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    const x = readPropertyWord(position),
      y = readPropertyWord(offset(position, 4));
    record.panel.style.left = `${x}px`;
    record.panel.style.top = `${y}px`;
    return 0;
  }

  addButton(output: AokanaBpPointer | null, id: number, label: AokanaBpPointer | null): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    if (record.buttons.length >= 3) return 0x80000006;
    if (label === null) throw new Error('Aokana property button decoder dereferences a null label');
    const button = this.document.createElement('button');
    button.type = 'button';
    button.textContent = this.text.decodeAuto(label);
    const index = record.buttons.length;
    button.addEventListener('click', () =>
      this.messages.post({target: record.target, message: 0x111, wParam: 0x445 + index, lParam: 0}),
    );
    record.buttonsElement.append(button);
    record.buttons.push(button);
    if (output !== null) writePropertyWord(output, index);
    return 0;
  }

  /** 1400b07b0 inserts an empty UI tab before its null-label native wcslen fault. */
  addTab(output: AokanaBpPointer | null, id: number, label: AokanaBpPointer | null): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000000;
    const name = label === null ? '' : this.text.decodeAuto(label);
    const button = this.document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.setAttribute('role', 'tab');
    record.tabsElement.append(button);
    if (label === null)
      throw new Error('Aokana property tab construction dereferences the null decoded label');
    const index = record.tabs.length;
    button.addEventListener('click', () =>
      this.postNotification(record, {kind: 'tab', tab: index}),
    );
    record.tabs.push({name, rows: [], selected: -1});
    if (output !== null) writePropertyWord(output, index);
    return 0;
  }

  addRow(
    output: AokanaBpPointer | null,
    id: number,
    tabIndex: number,
    name: AokanaBpPointer | null,
    kind: number,
    source: AokanaPropertySource | null,
    mutable: number,
    editable: number,
    refreshCallback: AokanaPropertyCallback | null = null,
    refreshContext: unknown = null,
    editCallback: AokanaPropertyCallback | null = null,
    editContext: unknown = null,
  ): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    const tab = record.tabs[tabIndex >>> 0];
    if (!tab) return 0x80000014;
    kind |= 0;
    const formatted = formatPropertySource(kind, source, this.text);
    if (formatted.result !== 0) return formatted.result;
    const row: AokanaPropertyRow = {
      name: name === null ? '' : this.text.decodeAuto(name),
      kind,
      value: kind === 5 ? 0 : readPropertyWord(source),
      rawCopy:
        kind === 5 && mutable !== 0
          ? textBytes(propertyTextPointer(source)).slice()
          : new Uint8Array(),
      formatted: formatted.value!,
      source: mutable === 0 ? null : source,
      mutable: mutable !== 0,
      editable: mutable === 0 ? 0 : editable | 0,
      refreshCallback: mutable === 0 ? null : refreshCallback,
      refreshContext: mutable === 0 ? null : refreshContext,
      editCallback: mutable === 0 || editable === 0 ? null : editCallback,
      editContext: mutable === 0 || editable === 0 ? null : editContext,
    };
    const index = tab.rows.length;
    tab.rows.push(row);
    if (tabIndex >>> 0 === record.selectedTab) this.renderRows(record);
    if (output !== null) writePropertyWord(output, index);
    return 0;
  }

  private row(id: number, tab: number, index: number): {result: number; row?: AokanaPropertyRow} {
    const record = this.records.get(id >>> 0);
    if (!record) return {result: 0x80000007};
    const selected = record.tabs[tab >>> 0];
    if (!selected) return {result: 0x80000014};
    const row = selected.rows[index >>> 0];
    return row ? {result: 0, row} : {result: 0x8000001f};
  }
  getValue(
    output: AokanaBpPointer | null,
    typeOutput: AokanaBpPointer | null,
    id: number,
    tab: number,
    index: number,
  ): number {
    const found = this.row(id, tab, index);
    if (found.result !== 0) return found.result;
    const row = found.row!;
    if (row.kind === 5) {
      if (output === null)
        throw new Error('Aokana property string retrieval dereferences null output');
      copyText(output, {bytes: this.text.encodeWide(row.formatted), offset: 0});
    } else writePropertyWord(output, row.value);
    if (typeOutput !== null) writePropertyWord(typeOutput, row.kind);
    return 0;
  }

  /** 1400acba0 visits std::map unsigned-ID order and returns zero even for an absent requested ID. */
  refresh(id: number): number {
    for (const record of [...this.records.values()].sort((a, b) => a.id - b.id)) {
      if (id >>> 0 !== 0 && record.id !== id >>> 0) continue;
      for (const [tabIndex, tab] of record.tabs.entries()) {
        let changed = false;
        for (const row of tab.rows) {
          if (
            !row.mutable ||
            (row.refreshCallback !== null && row.refreshCallback(row, row.refreshContext, 0) === 0)
          )
            continue;
          if (row.kind === 5) {
            if (row.source === null)
              throw new Error('Aokana live property string dereferences a null source');
            const pointer = propertyTextPointer(row.source);
            const bytes = textBytes(pointer);
            if (
              bytes.length === row.rawCopy.length &&
              bytes.every((value, index) => value === row.rawCopy[index])
            )
              continue;
            row.rawCopy = bytes.slice();
            row.formatted = this.text.decodeAuto(pointer);
          } else {
            const value = readPropertyWord(row.source);
            if (row.kind === 4 ? (value === 0) === (row.value === 0) : value === row.value)
              continue;
            row.value = value;
            row.formatted = formatPropertyScalar(row.kind, value);
          }
          changed = true;
        }
        if (changed && tabIndex === record.selectedTab) this.renderRows(record);
      }
    }
    return 0;
  }

  /** 1400ac700 uses a single 16-byte MOVUPS before unlinking the front list node. */
  poll(output: AokanaBpPointer | null, id: number): number {
    const record = this.records.get(id >>> 0);
    if (!record) return 0x80000007;
    const event = record.events[0];
    if (!event) return 0x8000001f;
    if (output === null) throw new Error('Aokana property event store dereferences null output');
    if (output.offset < 0 || output.offset + 16 > output.bytes.length)
      throw new RangeError('Aokana property event MOVUPS exceeds output storage');
    const values = new Uint8Array(16),
      view = new DataView(values.buffer);
    view.setInt32(0, event.kind, true);
    view.setInt32(4, event.value, true);
    output.bytes.set(values, output.offset);
    record.events.shift();
    return 0;
  }

  private postNotification(record: PropertyRecord, notification: Notification): void {
    const token = ++this.nextNotification;
    this.notifications.set(token, notification);
    this.messages.post({
      target: record.target,
      message: 0x4e,
      wParam: notification.kind === 'tab' ? 0x442 : 0x443,
      lParam: token,
    });
  }

  /** The concrete main-window FIFO routes this HWND's messages here. */
  async handleMessage(message: AokanaWindowMessage): Promise<boolean> {
    const record = [...this.records.values()].find((record) => record.target === message.target);
    if (!record) return false;
    if (message.message === 0x10) {
      record.closeRequested = true;
      this.messages.post({target: record.target, message: 0x111, wParam: 2, lParam: 0});
    } else if (message.message === 0x111) {
      const command = Number(BigInt(message.wParam) & 0xffffffffn) >>> 0;
      const index = (command & 0xffff) - 0x445;
      if (index >= 0 && index < 3 && command >>> 16 === 0)
        record.events.push({kind: 1, value: index});
    } else if (message.message === 0x4e) {
      const key = BigInt(message.lParam),
        notification = this.notifications.get(key);
      if (!notification)
        throw new Error('Aokana property notification dereferences an unknown native record');
      if (notification.kind === 'tab') {
        record.selectedTab = notification.tab >>> 0;
        if (!record.tabs[record.selectedTab])
          throw new RangeError('Aokana property tab callback indexes outside native records');
        this.renderRows(record);
        record.events.push({kind: 2, value: record.selectedTab});
      } else {
        const tab = record.tabs[record.selectedTab];
        if (!tab) throw new RangeError('Aokana property list callback indexes outside native tabs');
        if (notification.kind === 'selection') {
          const selected = notification.row | 0;
          if (record.uiSelected !== selected) {
            if (record.uiSelected >= 0) {
              tab.selected = -1;
              record.events.push({kind: 3, value: (record.selectedTab << 16) | 0xffff});
            }
            record.uiSelected = selected;
            tab.selected = selected;
            record.events.push({
              kind: 3,
              value: (record.selectedTab << 16) | (tab.selected & 0xffff),
            });
            this.renderRows(record);
          }
        } else {
          if (notification.row !== null) tab.selected = notification.row | 0;
          if (tab.selected >= 0) {
            const row = tab.rows[tab.selected];
            if (!row) throw new RangeError('Aokana property edit indexes outside native rows');
            if ((await this.editRow(record, row)) === 0) {
              this.renderRows(record);
              record.events.push({
                kind: 4,
                value: (record.selectedTab << 16) | (tab.selected & 0xffff),
              });
            }
          }
        }
      }
      this.notifications.delete(key);
    }
    return true;
  }

  private renderRows(record: PropertyRecord): void {
    if (record.displayedTab !== record.selectedTab) {
      record.rowsElement.replaceChildren();
      record.rowButtons.length = 0;
      record.displayedTab = record.selectedTab;
      record.uiSelected = -1;
    }
    const tab = record.tabs[record.selectedTab];
    if (!tab) return;
    for (const [index, row] of tab.rows.entries()) {
      let button = record.rowButtons[index];
      if (button !== undefined) {
        button.setAttribute('aria-selected', String(index === record.uiSelected));
        button.children[0]!.textContent = row.name;
        button.children[1]!.textContent = row.formatted;
        continue;
      }
      button = this.document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === record.uiSelected));
      button.style.cssText =
        'display:flex;text-align:left;background:transparent;color:inherit;border:0;padding:0';
      for (const [value, width] of [
        [row.name, record.columns[0]],
        [row.formatted, record.columns[1]],
      ] as const) {
        const cell = this.document.createElement('span');
        cell.textContent = value;
        cell.style.width = `${width}px`;
        button.append(cell);
      }
      button.addEventListener('click', () => {
        this.postNotification(record, {kind: 'selection', row: index});
      });
      button.addEventListener('dblclick', () =>
        this.postNotification(record, {kind: 'edit', row: index}),
      );
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.postNotification(record, {kind: 'edit', row: null});
        } else if (
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown' ||
          event.key === 'Home' ||
          event.key === 'End'
        ) {
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tab.rows.length - 1
                : Math.min(
                    tab.rows.length - 1,
                    Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1)),
                  );
          this.postNotification(record, {kind: 'selection', row: next});
          record.rowButtons[next]?.focus();
        }
      });
      record.rowsElement.append(button);
      record.rowButtons.push(button);
    }
  }

  /** 1400ad720 uses a modal child window without the engine-wide clock/cursor barriers. */
  private async editRow(record: PropertyRecord, row: AokanaPropertyRow): Promise<number> {
    if (row.editable === 0) return 0x80000006;
    const result = await this.showRowDialog(record, row);
    if (result === 0) return 2;
    if (!row.mutable || row.kind === 5) return 0;
    const old = readPropertyWord(row.source);
    if (row.kind === 4 ? (old === 0) === (row.value === 0) : old === row.value) return 0;
    if (row.editCallback === null) writePropertyWord(row.source, row.value);
    else row.editCallback(row, row.editContext, 0);
    return 0;
  }

  private showRowDialog(record: PropertyRecord, row: AokanaPropertyRow): Promise<number> {
    return new Promise((resolve, reject) => {
      const dialog = this.document.createElement('dialog');
      const heading = this.document.createElement('h2');
      heading.textContent = record.title;
      const label = this.document.createElement('label');
      label.textContent = row.name;
      const control =
        row.kind === 4
          ? this.document.createElement('select')
          : this.document.createElement('input');
      if (row.kind === 4) {
        for (const name of ['FALSE', 'TRUE']) {
          const option = this.document.createElement('option');
          option.textContent = name;
          control.append(option);
        }
        (control as HTMLSelectElement).selectedIndex = Number(row.value !== 0);
      } else {
        const input = control as HTMLInputElement;
        input.type = 'text';
        input.value = row.kind === 5 ? row.formatted : formatPropertyScalar(row.kind, row.value);
        input.addEventListener('beforeinput', (event) => {
          if (event.inputType !== 'insertText' || event.data === null) return;
          const start = input.selectionStart ?? 0,
            end = input.selectionEnd ?? start;
          let content = '',
            current = input.value;
          for (let index = 0; index < event.data.length; index++) {
            const code = propertyEditCharacter(
              row.kind,
              event.data.charCodeAt(index),
              current.slice(0, 1023),
              start + content.length,
            );
            if (code === null) continue;
            content += String.fromCharCode(code);
            current = input.value.slice(0, start) + content + input.value.slice(end);
          }
          event.preventDefault();
          if (content.length !== 0) input.setRangeText(content, start, end, 'end');
        });
        input.addEventListener('keydown', (event) => {
          if (
            event.key === 'Delete' &&
            !propertyEditDeleteAllowed(row.kind, input.selectionStart ?? 0)
          )
            event.preventDefault();
          if (
            event.key === 'Backspace' &&
            propertyEditCharacter(
              row.kind,
              8,
              input.value.slice(0, 1023),
              input.selectionStart ?? 0,
            ) === null
          )
            event.preventDefault();
        });
      }
      label.append(control);
      dialog.append(heading, label);
      const finish = (accept: boolean): void => {
        try {
          let result = 0;
          if (accept) {
            if (row.kind === 4) {
              row.value = (control as HTMLSelectElement).selectedIndex;
              row.formatted = formatPropertyScalar(4, row.value);
              result = 1;
            } else {
              const input = control.value.slice(0, 1023).split('\0', 1)[0]!;
              if (row.kind === 5) {
                row.formatted = input;
                result = 1;
              } else {
                const parsed = parseAokanaPropertyNumber(row.kind as 0 | 1 | 2 | 3, input);
                if (parsed.result === 0) {
                  row.value = parsed.value!;
                  row.formatted = formatPropertyScalar(row.kind, row.value);
                  result = 1;
                }
              }
            }
          }
          dialog.close();
          dialog.remove();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      for (const [name, accepted] of [
        ['OK', true],
        ['Cancel', false],
      ] as const) {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.textContent = name;
        button.addEventListener('click', () => finish(accepted));
        dialog.append(button);
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      });
      control.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
      });
      try {
        this.parent.append(dialog);
        dialog.showModal();
        control.focus();
        if (row.kind !== 4) (control as HTMLInputElement).select();
      } catch (error) {
        dialog.remove();
        reject(error);
      }
    });
  }
}
