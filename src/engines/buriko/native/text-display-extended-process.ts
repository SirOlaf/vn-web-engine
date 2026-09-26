import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoBpThread} from '../bp/state.js';
import type {BurikoBitmapRectangle} from './bitmap.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeNotifications} from './notification-queue.js';
import type {BurikoProcedureState} from './procedure.js';
import {textByte} from './text.js';
import {BurikoTextDisplayProcess} from './text-display-process.js';
import {
  buildBurikoHorizontalTextLayout,
  releaseBurikoHorizontalTextLayout,
  type BurikoHorizontalTextEffect,
  type BurikoHorizontalTextLayoutNode,
} from './text-layout-horizontal.js';
import {
  addBurikoHorizontalReadings,
  alignBurikoHorizontalTextNodes,
  BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
} from './text-layout-pipeline.js';

/** CProcDspMsgEx078b60/vtable17df60; shares the existing prepared glyph owners. */
export class BurikoExtendedTextDisplayProcess extends BurikoTextDisplayProcess {
  protected nodes: BurikoHorizontalTextLayoutNode[] = [];
  protected effect: BurikoHorizontalTextEffect;
  protected readingColor = 0;
  protected readingEnabled: number | undefined;
  private firstAdvance = true;
  private firstEmission = true;
  private previousRaw: bigint;
  private scaledTime: bigint;

  constructor(
    thread: BurikoBpThread,
    shared: BurikoProcedureState,
    clock: BurikoNativeClock,
    window: BurikoWindowDisplayObject,
    input: BurikoNativeInput,
    protected readonly notifications: BurikoNativeNotifications,
  ) {
    super(thread, shared, clock, window, input);
    this.effect = {...this.settings.defaultEffect};
    this.previousRaw = BigInt(this.rawNow());
    this.scaledTime = BigInt.asIntN(64, this.previousRaw << 16n);
    if (this.settings.field1D27A4 !== 0) window.saveText();
  }

  /** F2870's Ex configuration order: colors, prepare, then the four base options. */
  async initializeExtended(
    source: BurikoBpPointer | null,
    color: number,
    reading: number,
    wrapping: number,
    disableEffect: number,
    immediate: number,
    wait: number,
    highBit: number,
    otherBits: number,
    readingColor = color,
    explicitEffect?: BurikoHorizontalTextEffect,
  ): Promise<void> {
    const operationAllocator = this.settings.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    this.color = color >>> 0;
    this.readingColor = readingColor >>> 0;
    if (explicitEffect !== undefined) this.effect = {...explicitEffect};
    releaseBurikoHorizontalTextLayout(this.nodes);
    this.nodes = [];
    if (source === null) throw new Error('Buriko extended text preparation reads a null source');
    await runAsActor(() => this.prepare(source, reading, wrapping, disableEffect));
    this.immediate = immediate | 0;
    this.waitForInput = wait | 0;
    this.allowHighBit = highBit | 0;
    this.allowOtherBits = otherBits | 0;
  }
  protected async prepare(
    source: BurikoBpPointer,
    reading: number,
    wrapping: number,
    disableEffect: number,
  ): Promise<void> {
    const operationAllocator = this.settings.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    const cursor = runAsActor(() => this.window.getTextCursor()),
      originalY = cursor.y,
      region = runAsActor(() => this.window.getTextRectangle()),
      originalExtent = this.window.lineExtent,
      maximum = {value: originalExtent},
      effect = disableEffect === 0 ? this.effect : BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT;
    const built = await runAsActor(() =>
      buildBurikoHorizontalTextLayout(this.settings, {
        source,
        readingEnabled: reading,
        annotations: this.settings.annotations,
        cursor,
        rectangle: region,
        lineAdvance: this.window.textLineAdvance(),
        fontId: this.window.fontId,
        proportional: this.window.characterSpacing,
        wrapping,
        color: this.color,
        effect,
        maximumFontSize: maximum,
      }),
    );
    this.nodes = built.nodes;
    if (
      textByte(source.bytes, source.offset) !== 0 &&
      (cursor.y !== originalY || maximum.value >>> 0 > originalExtent >>> 0)
    )
      runAsActor(() => this.window.setLineExtent(maximum.value));
    if (built.result !== 0) {
      if (reading !== 0)
        await runAsActor(() =>
          addBurikoHorizontalReadings(
            this.settings,
            this.nodes,
            this.window.fontId,
            this.readingColor,
            effect,
            this.settings.annotations,
          ),
        );
      alignBurikoHorizontalTextNodes(
        this.settings,
        this.nodes,
        cursor,
        region,
        this.window.fontId,
        wrapping,
        effect,
        this.window.alignment,
      );
      runAsActor(() => this.window.setTextCursor(cursor.x, cursor.y));
      this.readingEnabled = reading | 0;
      this.schedule(0);
    }
  }
  protected allDone(): boolean {
    return this.nodes.every((node) => node.procedureTime !== 0);
  }
  /**0731a0 uses the zero-extended base DWORD clock, signed64 delta and wrapped Q16 accumulator. */
  protected override now(): bigint {
    const raw = BigInt(this.rawNow()),
      delta = BigInt.asIntN(64, raw - this.previousRaw);
    this.previousRaw = raw;
    const scale = this.allDone() ? 65536 : this.settings.field1C90FC >>> 0;
    this.scaledTime = BigInt.asIntN(64, this.scaledTime + BigInt(scale) * delta);
    return this.scaledTime >> 16n;
  }
  protected override advance(): boolean {
    if (this.settings.field1D1E54 !== 0 && this.firstAdvance) {
      this.deadline = Number(BigInt.asUintN(32, this.now()));
      this.firstAdvance = false;
    }
    if (
      this.settings.field1D1E54 === 0 &&
      !this.deadlineReached() &&
      this.skip === 0 &&
      !this.finishRequested &&
      this.autoDeadline === 0
    )
      return false;
    if (!this.allDone()) {
      this.emit();
      return false;
    }
    return this.endWait();
  }
  protected override afterNewline(): void {
    this.window.advanceTextCursor(this.settings.lineStartOffset);
  }
  protected override overlayOffset(): {x: number; y: number} {
    const font = this.settings.surfaces.fonts.find(this.window.fontId);
    if (this.readingEnabled === undefined)
      throw new Error('Buriko extended text reading flag is indeterminate');
    return {
      x: 0,
      y: this.readingEnabled !== 0 && font !== null ? this.settings.readingSize(font.size) : 0,
    };
  }

  /**073f30, actual tick-driven and absolute/saved-background emission paths. */
  private emit(): void {
    if (this.firstEmission) {
      this.notifications.push(0x30000002, 0, 0);
      this.firstEmission = false;
    }
    const immediate = this.skip !== 0 || this.immediate !== 0 || this.settings.field1C9100 === 0;
    // One native stack output rectangle persists across all node draws in this invocation.
    const area: BurikoBitmapRectangle = {left: 0, top: 0, right: 0, bottom: 0};
    let published = false;
    const draw = (node: BurikoHorizontalTextLayoutNode, mode: number, value: number): void => {
      if (this.window.drawTextBitmap(area, node.x, node.y, node.bitmap, mode, value) === 0)
        published = true;
    };
    const damage = (): void => {
      if (!published) throw new Error('Buriko extended text consumes indeterminate draw damage');
      this.damage(area);
      this.markDirty();
    };
    const transparency = (counter: number, duration: number): number => {
      if (duration >>> 0 === 0)
        throw new RangeError('Buriko extended text divides by zero duration');
      return (256 - Math.trunc(((counter << 8) >>> 0) / (duration >>> 0))) >>> 0;
    };
    if (this.settings.field1D1E54 === 0 && this.settings.field1D27A4 === 0) {
      let budget = 0;
      while (this.deadlineReached() && !immediate) {
        this.deadline = (this.deadline + 1) >>> 0;
        budget = (budget + 1) | 0;
      }
      do {
        if (budget === 0 && !immediate) break;
        budget = (budget - 1) | 0;
        for (const node of this.nodes) {
          if (node.procedureTime !== 0) continue;
          if (node.revealTime !== 0 && !immediate) {
            node.revealTime = (node.revealTime - 1) >>> 0;
            if (node.revealTime === 0) {
              node.interval = this.settings.field1C90E8 >>> 0;
              node.procedureState = 0;
            }
            continue;
          }
          const fading = node.procedureState >>> 0 < node.interval >>> 0 && !immediate;
          if (fading && budget !== 0) {
            node.procedureState = (node.procedureState + 1) >>> 0;
            continue;
          }
          draw(node, 0x40, 1);
          draw(node, 1, fading ? transparency(node.procedureState, node.interval) : 0);
          damage();
          if (fading) node.procedureState = (node.procedureState + 1) >>> 0;
          else node.procedureTime = 1;
        }
      } while (!immediate);
      this.schedule(0);
      return;
    }
    if (this.settings.field1D27A4 !== 0) {
      this.window.restoreText();
      Object.assign(area, this.window.textBitmapRectangle());
      published = true;
      damage();
    }
    const elapsed = Number(BigInt.asUintN(32, this.now() - BigInt(this.deadline)));
    for (const node of this.nodes) {
      if (node.revealTime >>> 0 > elapsed && !immediate) continue;
      if (node.kind >>> 0 === 0x80000000) {
        if (node.procedureTime === 0) {
          this.notifications.push(0x30000001, node.x, node.y);
          node.procedureTime = 1;
        }
        continue;
      }
      if (node.procedureTime !== 0 && this.settings.field1D27A4 === 0) continue;
      node.procedureState = (elapsed - node.revealTime) >>> 0;
      const done = node.procedureState >>> 0 >= node.interval >>> 0 || immediate;
      if (this.settings.field1D27A4 === 0) draw(node, 0x40, 1);
      draw(node, 1, done ? 0 : transparency(node.procedureState, node.interval));
      if (this.settings.field1D27A4 === 0) damage();
      if (done) node.procedureTime = 1;
    }
  }
  override dispose(): void {
    this.window.saveText();
    releaseBurikoHorizontalTextLayout(this.nodes);
    this.nodes = [];
    super.dispose();
  }
}
