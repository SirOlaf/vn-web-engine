import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeInput} from './input.js';
import {BurikoDiagnosticDialogs} from './modal.js';
import {BurikoNativeText} from './text.js';
import {terminatedNativeBytes} from './program-files.js';
import type {BurikoNativeDisplayState} from './display-state.js';
import type {BurikoBpPointer} from '../bp/memory.js';

/** Exact display-device queries used by 1400b34f0; implemented by Buriko's device manager. */
export interface BurikoModalDisplayDevice {
  isPresent(): boolean;
  refresh(dialogBoxMode: boolean): void;
}

/** The binary retains the requested integer, separately from the OS cursor visibility count. */
export class BurikoNativeCursor {
  private visible = 1;
  private shape = '';
  constructor(readonly surface: HTMLElement) {}

  /** SetCursor changes the retained shape independently of ShowCursor visibility. */
  setShape(css: string): void {
    this.shape = css;
    if (this.visible !== 0) this.surface.style.cursor = css;
  }

  get requestedVisibility(): number {
    return this.visible;
  }

  setVisible(value: number): number {
    value |= 0;
    const previous = this.visible;
    if ((value === 0) === (previous === 0)) return previous;
    this.visible = value;
    this.surface.style.cursor = value === 0 ? 'none' : this.shape;
    return previous;
  }
}

/** Native fatal/quit exception carried through a blocking browser continuation. */
export class BurikoNativeExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 1400b0d10: display transition, clock, cursor, mixed text, modal, then input/clock restoration. */
export class BurikoEngineDialogs {
  constructor(
    private readonly presenter: BurikoDiagnosticDialogs,
    private readonly text: BurikoNativeText,
    private readonly clock: BurikoNativeClock,
    private readonly input: BurikoNativeInput,
    private readonly cursor: BurikoNativeCursor,
    private readonly device: BurikoModalDisplayDevice,
    private readonly display: BurikoNativeDisplayState,
    public preferredTitle: Uint8Array | null,
    public fallbackTitle: Uint8Array,
  ) {}

  /** Composition check for VM dialogs sharing the actual graph modal and input owners. */
  usesOwners(
    presenter: BurikoDiagnosticDialogs,
    text: BurikoNativeText,
    clock: BurikoNativeClock,
    input: BurikoNativeInput,
    cursor: BurikoNativeCursor,
    device: BurikoModalDisplayDevice,
    display: BurikoNativeDisplayState,
  ): boolean {
    return (
      this.presenter === presenter &&
      this.text === text &&
      this.clock === clock &&
      this.input === input &&
      this.cursor === cursor &&
      this.device === device &&
      this.display === display
    );
  }

  /** 1400b34f0, also used by persistent native child/settings windows without clock suspension. */
  transition(enter: boolean): void {
    if (!this.device.isPresent()) return;
    if (enter) {
      if (
        this.display.modalDepth === 0 &&
        this.display.fullscreen === 1 &&
        this.display.displayFlag === 0
      ) {
        this.device.refresh(true);
      }
      this.display.modalDepth = (this.display.modalDepth + 1) | 0;
    } else {
      this.display.modalDepth = (this.display.modalDepth - 1) | 0;
      if (
        this.display.modalDepth === 0 &&
        this.display.fullscreen === 1 &&
        this.display.displayFlag === 0
      ) {
        this.device.refresh(false);
      }
    }
  }

  /** Shared native modal barriers, also used by 1400b0c40's list-selection dialog. */
  async withNativeModal<T>(operation: () => Promise<T>): Promise<T> {
    this.transition(true);
    this.clock.beginSuspension(true);
    const oldCursor = this.cursor.setVisible(1);
    const result = await operation();
    this.cursor.setVisible(oldCursor);
    this.input.clearTransientKeys();
    this.clock.endSuspension();
    this.transition(false);
    return result;
  }

  async show(
    message: Uint8Array | BurikoBpPointer | null,
    title: Uint8Array | BurikoBpPointer | null,
    flags: number,
  ): Promise<1 | 2 | 6 | 7> {
    return this.withNativeModal(async () => {
      // f8e00's narrow replacement runs on UTF-8: the ASCII sequence backslash+n becomes LF.
      if (message === null) throw new Error('Buriko engine modal dereferences a null message');
      const source =
        message instanceof Uint8Array
          ? {bytes: terminatedNativeBytes(message), offset: 0}
          : message;
      const content = this.text.decodeMixed(source).replace(/\\n/g, '\n');
      const captionSource = title ?? this.preferredTitle ?? this.fallbackTitle;
      const caption = this.text.decodeAuto(
        captionSource instanceof Uint8Array
          ? {bytes: terminatedNativeBytes(captionSource), offset: 0}
          : captionSource,
      );
      const buttonKind = flags & 15;
      if (buttonKind !== 0 && buttonKind !== 1 && buttonKind !== 4)
        throw new RangeError('Buriko engine modal uses unsupported native button kind');
      const result = await this.presenter.show({
        title: caption,
        text: content,
        buttons: buttonKind === 4 ? 'yes-no' : buttonKind === 1 ? 'ok-cancel' : 'ok',
        defaultSecondButton: (flags & 0x300) === 0x100,
      });
      return result;
    });
  }

  /** Actual browser presenter remains owned by the title's modal service. */
  chooseList(
    title: string,
    prompt: string,
    faces: readonly string[],
  ): Promise<{accepted: boolean; index: number | null}> {
    return this.presenter.chooseFont({title, prompt, faces});
  }
}
