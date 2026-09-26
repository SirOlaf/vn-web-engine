import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoEngineDialogs} from './engine-dialogs.js';

interface SettingsEvent {
  readonly kind: number;
  readonly value: number;
  next: SettingsEvent | null;
  alive: boolean;
}
interface SettingsRecord {
  readonly id: number;
  window: HTMLElement | null;
  visible: number;
  head: SettingsEvent | null;
  tail: SettingsEvent | null;
  retired: boolean;
}

function word(pointer: BurikoBpPointer, offset: number): number {
  const at = pointer.offset + offset;
  if (at < 0 || at + 4 > pointer.bytes.length)
    throw new RangeError('Buriko settings read exceeds native input storage');
  return new DataView(
    pointer.bytes.buffer,
    pointer.bytes.byteOffset,
    pointer.bytes.byteLength,
  ).getInt32(at, true);
}
function writeWord(pointer: BurikoBpPointer, offset: number, value: number): void {
  const at = pointer.offset + offset;
  if (at < 0 || at + 4 > pointer.bytes.length)
    throw new RangeError('Buriko settings write exceeds native output storage');
  new DataView(pointer.bytes.buffer, pointer.bytes.byteOffset, pointer.bytes.byteLength).setInt32(
    at,
    value,
    true,
  );
}

/** Native settings-dialog records, including 1400ae830's non-advancing tail pointer. */
export class BurikoModelessSettings {
  private nextId = 0;
  private closed = false;
  private readonly records: SettingsRecord[] = [];
  // A node overwritten in the native tail link is leaked, not implicitly deallocated.
  private readonly allocations = new Set<SettingsEvent>();
  constructor(
    readonly document: Document,
    readonly parent: HTMLElement,
    readonly dialogs: BurikoEngineDialogs,
  ) {}

  /** 1400ae1c0 supports only template kind zero. Initial values contain nine DWORDs. */
  create(kind: number, initial: BurikoBpPointer | null): {result: number; id?: number} {
    if (this.closed) throw new Error('Buriko settings owner is closed');
    if ((kind | 0) !== 0) return {result: 0x80000001};
    const panel = this.document.createElement('section');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '環境設定');
    panel.style.cssText =
      'position:fixed;inset:10vh auto auto 50%;transform:translateX(-50%);z-index:20;background:Canvas;color:CanvasText;border:1px solid;padding:1rem;max-height:80vh;overflow:auto';
    this.parent.append(panel);
    if (initial === null)
      throw new Error('Buriko settings dialog dereferences a null initial-value pointer');
    const values = Array.from({length: 9}, (_, index) => word(initial, index * 4));
    const sliders: HTMLInputElement[] = [];
    for (const [index, name] of [
      '文字表示速度',
      'オートモード速度',
      'BGM',
      '効果音',
      '音声',
    ].entries()) {
      const label = this.document.createElement('label');
      label.textContent = name;
      const control = this.document.createElement('input');
      control.type = 'range';
      control.min = '0';
      control.max = '128';
      control.step = '1';
      control.value = String(Math.min(128, Math.max(0, values[index]!)));
      label.append(control);
      panel.append(label);
      sliders.push(control);
    }
    const groups = [
      ['表示スタイル', ['ウィンドウ', 0], ['フルスクリーン', 1]],
      ['スキップの動作', ['既読のみ', 0], ['全て', 1]],
      ['画面切り替え', ['通常遷移', 1], ['瞬間遷移', 0]],
      ['改ページ時の音声停止', ['する', 1], ['しない', 0]],
    ] as const;
    this.nextId = (this.nextId + 1) | 0;
    const record: SettingsRecord = {
      id: this.nextId,
      window: panel,
      visible: 0,
      head: null,
      tail: null,
      retired: false,
    };
    for (const [index, choices] of groups.entries()) {
      const group = this.document.createElement('fieldset');
      const legend = this.document.createElement('legend');
      legend.textContent = choices[0];
      group.append(legend);
      for (const [caption, value] of choices.slice(1) as readonly (readonly [string, number])[]) {
        const label = this.document.createElement('label');
        label.textContent = caption;
        const radio = this.document.createElement('input');
        radio.type = 'radio';
        radio.name = `buriko-settings-${record.id}-${index}`;
        radio.checked = values[index + 5] === value;
        radio.addEventListener('click', () => this.enqueue(record, index + 5, value));
        label.prepend(radio);
        group.append(label);
      }
      panel.append(group);
    }
    sliders.forEach((slider, index) => {
      // TB_THUMBTRACK reports every drag movement; TB_ENDTRACK reports its final value again.
      slider.addEventListener('input', () => this.enqueue(record, index, Number(slider.value)));
      slider.addEventListener('change', () => this.enqueue(record, index, Number(slider.value)));
    });
    const close = this.document.createElement('button');
    close.type = 'button';
    close.textContent = '閉じる';
    close.addEventListener('click', () => this.closeWindow(record));
    panel.append(close);
    this.records.unshift(record);
    return {result: 0, id: record.id};
  }

  /** 1400ae830 never updates +20 on a nonempty append. */
  private enqueue(record: SettingsRecord, kind: number, value: number): void {
    if (this.closed || record.retired) return;
    const event: SettingsEvent = {kind: kind | 0, value: value | 0, next: null, alive: true};
    this.allocations.add(event);
    if (record.tail === null) record.head = record.tail = event;
    else {
      if (!record.tail.alive)
        throw new Error(
          'Buriko settings event append writes through the native freed tail pointer',
        );
      record.tail.next = event;
    }
  }

  /** Native user messages may continue to target a record after its window closes. */
  private closeWindow(record: SettingsRecord): void {
    if (record.window === null) return;
    this.enqueue(record, -1, 0);
    const panel = record.window;
    record.window = null;
    if (record.visible !== 0) {
      record.visible = 0;
      this.dialogs.transition(false);
    }
    panel.remove();
  }

  /** 1400ae0b0 reports an error for a redundant visibility request. */
  show(id: number, visible: number): number {
    const record = this.records.find((record) => record.id === (id | 0));
    visible |= 0;
    if (!record || (record.visible === 0) === (visible === 0)) return 0x80000000;
    record.visible = visible;
    this.dialogs.transition(visible !== 0);
    if (record.window !== null) record.window.hidden = visible === 0;
    return 0;
  }

  /** 1400ae7b0 writes two DWORDs followed by a NULL next pointer before unlinking. */
  poll(id: number, output: BurikoBpPointer | null): number {
    const record = this.records.find((record) => record.id === (id | 0));
    if (!record) return 0x80000000;
    const event = record.head;
    if (event === null) return 1;
    if (output !== null) {
      writeWord(output, 0, event.kind);
      writeWord(output, 4, event.value);
      const at = output.offset + 8;
      if (at < 0 || at + 8 > output.bytes.length)
        throw new RangeError('Buriko settings next-pointer write exceeds native output storage');
      new DataView(
        output.bytes.buffer,
        output.bytes.byteOffset,
        output.bytes.byteLength,
      ).setBigUint64(at, 0n, true);
    }
    record.head = event.next;
    event.alive = false;
    this.allocations.delete(event);
    if (record.head === null) record.tail = null;
    return 0;
  }

  /** 1400ae120 closes the window, drains its reachable queue, and unlinks the record. */
  destroy(id: number): number {
    const index = this.records.findIndex((record) => record.id === (id | 0));
    if (index < 0) return 0x80000000;
    this.closeWindow(this.records[index]!);
    while (this.poll(id, null) === 0) {
      /* Each native event allocation is released by poll. */
    }
    this.records.splice(index, 1);
    return 0;
  }

  /** Host final close discards every event without emitting a native close notification. */
  disposeAll(): void {
    if (this.closed) return;
    this.closed = true;
    const records = this.records.splice(0);
    let firstError: unknown;
    let failed = false;
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    };
    for (const record of records) {
      record.retired = true;
      const panel = record.window;
      record.window = null;
      const wasVisible = record.visible !== 0;
      record.visible = 0;
      record.head = null;
      record.tail = null;
      if (wasVisible) attempt(() => this.dialogs.transition(false));
      if (panel !== null) attempt(() => panel.remove());
    }
    // The fixed native tail link can orphan allocations that a head walk cannot find.
    for (const event of this.allocations) {
      event.alive = false;
      event.next = null;
    }
    this.allocations.clear();
    if (failed) throw firstError;
  }
}
