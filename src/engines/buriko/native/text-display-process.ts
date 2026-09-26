import type {BurikoBpPointer} from '../bp/memory.js';
import {push32, type BurikoBpThread} from '../bp/state.js';
import {allocateBurikoBitmap, type BurikoBitmapRectangle} from './bitmap.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoWindowDisplayObject} from './display-window.js';
import {rasterBurikoGlyph} from './font-bitmap.js';
import {recordBurikoBitmapText} from './bitmap-dom-text.js';
import type {BurikoNativeInput} from './input.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import {
  isNativeCp932Lead,
  isNativePunctuation,
  nativeCp932CharacterToWide,
  textByte,
} from './text.js';
import type {BurikoBpProcessMessage} from './types.js';

function divide(value: number, divisor: number): number {
  value |= 0;
  divisor |= 0;
  if (divisor === 0 || (value === -2147483648 && divisor === -1))
    throw new RangeError('Buriko animated text native signed quotient is undefined');
  return Math.trunc(value / divisor) | 0;
}
const rectangle = (): BurikoBitmapRectangle => ({left: 0, top: 0, right: 0, bottom: 0});

/** CProcDspMsg073090, base vtable17dc18. Owns capture/procedure state, borrows window/text. */
export class BurikoTextDisplayProcess extends BurikoProcedure {
  protected readonly settings;
  protected readonly manager;
  protected captureToken: number;
  protected source: BurikoBpPointer | null = null;
  protected sourceOffset = 0;
  protected color = 0;
  protected inputBits = 0;
  protected immediate = 0;
  protected skip = 0;
  protected waitForInput = 0;
  protected allowHighBit = 0;
  protected allowOtherBits = 0;
  protected initialWaitEnabled: number;
  protected initialWaitDeadline: number;
  protected autoDeadline = 0;
  protected scrolling = false;
  protected phase = 0;
  protected extendedRight = false;
  protected pageInitialized = false;
  protected remainingLines = 0;
  protected finishRequested = false;
  protected dirty = false;
  private scrollSteps = 0;
  private scrollInterval = 0;
  private fadeSteps = 0;
  private fadeInterval = 0;

  constructor(
    thread: BurikoBpThread,
    shared: BurikoProcedureState,
    clock: BurikoNativeClock,
    protected readonly window: BurikoWindowDisplayObject,
    protected readonly input: BurikoNativeInput,
  ) {
    super(thread, shared, clock);
    this.settings = window.windowState.textLayout;
    this.manager = window.windowState.manager;
    const mode = this.settings.captureMode;
    if (mode === 0) this.captureToken = 2;
    else if (mode === 1) this.captureToken = ((this.settings.captureLayer << 16) | 0xffff) >>> 0;
    else if (mode === 2) this.captureToken = ((window.getLayer() << 16) | 0xffff) >>> 0;
    else throw new Error('Buriko animated text capture token is indeterminate');
    input.installPointerCapture(this.captureToken);
    input.installKeyCapture(this.captureToken);
    input.collect(this.captureToken, this.captureToken);
    window.setTextTransparency(0);
    window.setTextEnabled(1);
    window.composeAll();
    window.disableOverlays();
    this.initialWaitEnabled = this.settings.initialWaitEnabled;
    this.initialWaitDeadline = (this.rawNow() + this.settings.initialWaitInterval) >>> 0;
  }

  initialize(
    source: BurikoBpPointer | null,
    color: number,
    immediate: number,
    waitForInput: number,
    allowHighBit: number,
    allowOtherBits: number,
  ): void {
    this.color = color >>> 0;
    this.source = source;
    this.sourceOffset = source?.offset ?? 0;
    this.schedule(0);
    this.immediate = immediate | 0;
    this.waitForInput = waitForInput | 0;
    this.allowHighBit = allowHighBit | 0;
    this.allowOtherBits = allowOtherBits | 0;
  }
  protected rawNow(): number {
    return Number(BigInt.asUintN(32, this.clock.read()));
  }
  protected now(): bigint {
    return BigInt(this.rawNow());
  }
  protected override deadlineReached(): boolean {
    return BigInt(this.deadline) <= this.now();
  }
  /** 071e30 delegates to06fe60/add or06fe70/current virtual time. */
  protected schedule(duration: number): void {
    if ((duration | 0) !== 0 && this.skip === 0 && (this.immediate === 0 || this.scrolling))
      this.deadline = (this.deadline + duration) >>> 0;
    else this.deadline = Number(BigInt.asUintN(32, this.now()));
  }
  protected override handleMessage(message: BurikoBpProcessMessage): void {
    if (message.code === 0x100) this.finishRequested = true;
    else if (message.code === 0x101) this.allowHighBit = message.value1 | 0;
    else if (message.code === 1 || message.code === 0x102) {
      this.finishRequested = true;
      this.immediate = 1;
    }
  }
  protected markDirty(): void {
    if (this.settings.suppressProcedureRedraw === 0) this.dirty = true;
  }
  protected damage(area: BurikoBitmapRectangle | null): void {
    if (area !== null) this.manager.environment.damage.record(this.window.sortKey(), area);
  }
  poll(): number {
    this.consumeMessages();
    let bits =
      this.input.collect(this.captureToken, this.captureToken) &
      (this.input.allowMask | 0x80000181);
    if (this.allowHighBit === 0) bits &= 0x7fffffff;
    if (this.allowOtherBits === 0) bits &= ~(this.input.allowMask | 0x80);
    this.inputBits = bits >>> 0;
    if (bits !== 0) {
      this.skip = 1;
      if (this.settings.finishOnInput !== 0) this.finishRequested = true;
    }
    const finished = this.advance();
    if (
      this.dirty &&
      this.window.sortKey() >>> 0 >= this.manager.minimumKey >>> 0 &&
      this.manager.redraw.automaticEnabled !== 0
    ) {
      this.manager.redraw.request(this.manager.redraw.automaticMode !== 0 ? 1 : 0);
      this.dirty = false;
    }
    if (!finished && this.canRun()) return 0;
    push32(this.thread, this.skip);
    return 1;
  }
  /** 071e60's initial gate and repeat gate deliberately differ. */
  protected advance(): boolean {
    if (
      !this.deadlineReached() &&
      this.skip === 0 &&
      !this.finishRequested &&
      this.autoDeadline === 0
    )
      return false;
    do {
      if (this.scrolling) this.scroll();
      else {
        if (this.source === null)
          throw new Error('Buriko animated text reads a null borrowed source');
        const byte = textByte(this.source.bytes, this.sourceOffset);
        if (byte === 0) return this.endWait();
        if (byte === 1) this.sourceOffset += this.page();
        else if (byte === 10) {
          if (this.window.newTextLine() === 0) this.scrolling = true;
          this.extendedRight = false;
          this.sourceOffset++;
        } else if (byte === 12) this.sourceOffset += Number(this.formFeed());
        else this.sourceOffset += this.glyph();
      }
    } while (this.deadlineReached() || this.skip !== 0 || this.immediate !== 0);
    return false;
  }
  /** 071640, two phases over the same borrowed CP932 character. */
  private glyph(): number {
    const bytes = this.source!.bytes;
    const first = textByte(bytes, this.sourceOffset);
    const full = isNativeCp932Lead(first);
    const encoded = full ? (first << 8) | textByte(bytes, this.sourceOffset + 1) : first;
    this.schedule(this.settings.glyphInterval);
    const font = this.settings.surfaces.fonts.find(this.window.fontId);
    if (font === null) return 0;
    if (font.raster === null)
      throw new Error('Buriko animated text reads undefined font raster state');
    const scratch = allocateBurikoBitmap(Math.imul(font.size, 2), font.size, 1);
    try {
      const wide = nativeCp932CharacterToWide(encoded);
      if (wide === 0) throw new Error('Buriko animated text glyph metrics are indeterminate');
      const glyph = rasterBurikoGlyph(scratch, font.raster, wide, this.color);
      const view = {...scratch};
      let advance = divide(Math.imul(font.widthPercent, font.size), 100),
        bearing = 0;
      if (this.window.characterSpacing === 0) {
        if (!full) advance = divide(advance, 2);
      } else {
        const width = (glyph.right - glyph.left + 1) | 0;
        view.width = Math.min(width >>> 0, (view.width - glyph.left) >>> 0);
        view.offset += Math.imul(view.bytesPerPixel, glyph.left) >>> 0;
        const index = divide(Math.imul(width, 16), font.size);
        const selected = index >= 8 ? 1 : [4, 4, 4, 3, 3, 3, 3, 2][index];
        if (selected === undefined)
          throw new Error('Buriko animated glyph bearing reads outside native table');
        bearing = selected;
        advance = (width + Math.imul(bearing, 2)) | 0;
      }
      if (this.phase === 0) {
        if (!this.window.textAdvanceFits(advance)) {
          if (this.window.extendTextRight !== 0 && isNativePunctuation(wide) && !this.extendedRight)
            this.extendedRight = true;
          else {
            this.extendedRight = false;
            if (this.window.newTextLine() === 0) {
              this.scrolling = true;
              return 0;
            }
          }
        }
        const cursor = this.window.getTextCursor();
        this.window.setOverlayBitmap(0, view);
        this.window.setOverlayPosition(0, (cursor.x + bearing) | 0, cursor.y, 0xaa);
        this.window.setOverlayEnabled(0, 1);
        this.damage(this.window.overlayRectangle(0));
        this.phase++;
        this.markDirty();
        return 0;
      }
      const cursor = this.window.getTextCursor(),
        effect = this.settings.defaultEffect;
      const x = (cursor.x + bearing) | 0;
      const dx = divide(Math.imul(effect.radiusXPercent, font.size), 100),
        dy = divide(Math.imul(effect.radiusYPercent, font.size), 100);
      const damage = rectangle();
      let damagePublished = false;
      if (effect.mode !== 0) {
        const shadow = allocateBurikoBitmap(view.width, view.height, 1);
        try {
          clearBurikoBitmap(shadow);
          this.manager.environment.compositor.composite(shadow, view, 5, 256, true);
          recordBurikoBitmapText(shadow, '', {decorative: true, color: effect.color});
          damagePublished =
            this.window.drawTextBitmap(
              damage,
              (x + dx) | 0,
              (cursor.y + dy) | 0,
              shadow,
              1,
              (256 - effect.opacity) | 0,
            ) === 0;
        } finally {
          shadow.storage?.release();
        }
      }
      if (this.window.drawTextBitmap(damage, x, cursor.y, view, 0, 0) === 0) damagePublished = true;
      this.window.setOverlayEnabled(0, 0);
      if (!damagePublished)
        throw new Error('Buriko animated text consumes an indeterminate glyph damage rectangle');
      if (effect.mode !== 0) {
        damage.right = (damage.right + dx) | 0;
        damage.bottom = (damage.bottom + dy) | 0;
      }
      this.damage(damage);
      this.window.advanceTextCursor(advance);
      this.phase--;
      this.markDirty();
      return full ? 2 : 1;
    } finally {
      scratch.storage?.release();
    }
  }
  /** 071d10's ordinary-orientation loop is statically nonterminating in this executable. */
  private page(): number {
    if (!this.pageInitialized) {
      const region = this.window.getTextRectangle(),
        cursor = this.window.getTextCursor();
      this.remainingLines = (this.window.textLineCount() - Number(cursor.x === region.left)) | 0;
      if (this.window.writingDirection === 0 || this.window.writingDirection === 1)
        throw new Error(
          'Buriko native page-control loop does not terminate for this writing direction',
        );
      while (this.window.newTextLine() !== 0) this.remainingLines = (this.remainingLines - 1) | 0;
      this.pageInitialized = true;
    }
    if (this.remainingLines < 1) {
      this.window.resetTextCursor();
      this.extendedRight = false;
      this.pageInitialized = false;
      return 1;
    }
    this.remainingLines--;
    this.scrolling = true;
    return 0;
  }
  private scroll(): void {
    if (this.phase === 0) {
      this.scrollSteps = this.settings.scrollSteps;
      this.scrollInterval = this.settings.scrollInterval;
    }
    this.schedule(this.scrollInterval);
    const step = this.skip === 0 ? 1 : (this.scrollSteps - this.phase) | 0;
    const advance = this.window.textLineAdvance();
    const delta =
      (divide(Math.imul((this.phase + step) | 0, advance), this.scrollSteps) -
        divide(Math.imul(this.phase, advance), this.scrollSteps)) |
      0;
    this.window.scrollText(delta);
    this.phase = (this.phase + step) | 0;
    if (this.phase >= this.scrollSteps) {
      this.scrolling = false;
      this.phase = 0;
    }
    this.damage(this.window.textBitmapRectangle());
    this.markDirty();
  }
  protected formFeed(): boolean {
    if (this.phase === 0) {
      this.fadeSteps = this.settings.fadeSteps;
      this.fadeInterval = this.settings.fadeInterval;
    }
    this.schedule(this.fadeInterval);
    const done = this.phase >= ((this.fadeSteps - 1) | 0);
    if (done) {
      this.phase = 0;
      this.window.clearText();
      this.window.setTextTransparency(0);
      this.window.composeAll();
      this.window.resetTextCursor();
      this.extendedRight = false;
    } else {
      this.phase = (this.phase + 1) | 0;
      this.window.setTextTransparency(divide(Math.imul(this.phase, 256), this.fadeSteps));
      this.window.composeAll();
    }
    this.damage(this.window.textBitmapRectangle());
    this.markDirty();
    return done;
  }
  protected endWait(): boolean {
    if (this.waitForInput === 0 || this.finishRequested) {
      const overlay = this.window.overlayRectangle(0);
      if (overlay !== null) {
        this.damage(overlay);
        this.window.setOverlayEnabled(0, 0);
      }
      this.markDirty();
      return true;
    }
    if (this.settings.autoWaitEnabled !== 0 && this.phase === 0)
      this.autoDeadline = (this.rawNow() + this.settings.autoWaitInterval) >>> 0;
    if (this.initialWaitEnabled !== 0) {
      if (this.rawNow() < this.initialWaitDeadline && this.skip === 0) return false;
      this.initialWaitEnabled = 0;
    }
    let done = false;
    if (this.deadlineReached() || this.skip !== 0) done = this.waitOverlay();
    if (this.settings.autoWaitEnabled !== 0 && !done && this.autoDeadline <= this.rawNow())
      this.finishRequested = true;
    return done;
  }
  protected afterNewline(): void {}
  protected overlayOffset(): {x: number; y: number} {
    return {x: 0, y: 0};
  }
  private waitOverlay(): boolean {
    const frames = this.settings.overlayFrames,
      count = this.settings.overlayFrameCount | 0;
    if (this.phase === 0) {
      let width = 0;
      for (let index = 0; index < count; index++) {
        const frame = frames?.[index];
        if (frame === undefined)
          throw new Error('Buriko animated overlay reads undefined frame storage');
        width = Math.max(width, frame.width >>> 0);
      }
      const mode = this.settings.overlayPositionMode;
      if (!this.window.textAdvanceFits(width) && mode !== 2 && mode !== 4) {
        if (this.window.newTextLine() === 0) {
          this.scrolling = true;
          return false;
        }
        this.afterNewline();
      }
      this.inputBits = (this.inputBits & 0x80000000) >>> 0;
      if (this.inputBits === 0) this.skip = 0;
      this.immediate = 0;
      this.schedule(0);
      this.phase++;
    }
    this.damage(this.window.overlayRectangle(0));
    const done = this.inputBits !== 0;
    if (done) {
      this.window.setOverlayEnabled(0, 0);
      this.phase = 0;
    } else {
      this.schedule(this.settings.overlayFrameInterval);
      if (count > 0) {
        const frame = frames?.[this.phase - 1];
        this.phase = (this.phase + (this.phase < count ? 1 : 1 - count)) | 0;
        if (frame === undefined)
          throw new Error('Buriko animated overlay reads undefined frame storage');
        if (frame.storage === null) this.window.setOverlayEnabled(0, 0);
        else {
          const mode = this.settings.overlayPositionMode,
            offset = this.overlayOffset();
          let x = this.settings.overlayPositionX,
            y = this.settings.overlayPositionY;
          if (mode !== 1) {
            if (mode < 0 || mode > 4)
              throw new Error('Buriko overlay coordinates are indeterminate');
            const cursor = this.window.getTextCursor();
            x = (x + cursor.x + offset.x) | 0;
            y =
              (y +
                cursor.y +
                offset.y +
                this.window.lineExtent -
                (mode === 0 || mode === 2 ? this.window.fontSize : frame.height)) |
              0;
          }
          this.window.setOverlayPosition(0, x, y, 0);
          this.window.setOverlayBitmap(0, frame);
          this.window.setOverlayEnabled(0, 1);
        }
      }
    }
    this.damage(this.window.overlayRectangle(0));
    this.markDirty();
    return done;
  }
  override dispose(): void {
    this.input.releasePointerCapture(this.captureToken);
    this.input.releaseKeyCapture(this.captureToken);
    super.dispose();
  }
}
