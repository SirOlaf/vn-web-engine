import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoExtendedTextDisplayProcess} from './text-display-extended-process.js';
import {BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT} from './text-layout-pipeline.js';
import {
  buildBurikoVerticalTextLayout,
  addBurikoVerticalReadings,
  alignBurikoVerticalTextNodes,
} from './text-layout-vertical.js';

/**07a890/17e1a0 replaces only build, readings, alignment and wait-overlay offset. */
export class BurikoVerticalTextDisplayProcess extends BurikoExtendedTextDisplayProcess {
  protected override async prepare(
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
      region = runAsActor(() => this.window.getTextRectangle()),
      effect = disableEffect === 0 ? this.effect : BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT;
    const built = runAsActor(() =>
      buildBurikoVerticalTextLayout(this.settings, {
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
      }),
    );
    this.nodes = built.nodes;
    if (built.result !== 0) {
      if (reading !== 0)
        await runAsActor(() =>
          addBurikoVerticalReadings(
            this.settings,
            this.nodes,
            this.window.fontId,
            this.readingColor,
            effect,
            this.settings.annotations,
          ),
        );
      alignBurikoVerticalTextNodes(
        this.settings,
        this.nodes,
        cursor,
        region,
        this.window.fontId,
        wrapping,
        this.window.alignment,
      );
      runAsActor(() => this.window.setTextCursor(cursor.x, cursor.y));
      this.readingEnabled = reading | 0;
      this.schedule(0);
    }
  }
  protected override overlayOffset(): {x: number; y: number} {
    const font = this.settings.surfaces.fonts.find(this.window.fontId);
    if (this.readingEnabled === undefined)
      throw new Error('Buriko vertical message reading flag is indeterminate');
    const reading =
      this.readingEnabled !== 0 && font !== null ? this.settings.readingSize(font.size) : 0;
    const first = this.settings.overlayFrames?.[0];
    if (first === undefined)
      throw new Error('Buriko vertical message reads absent first overlay-frame descriptor');
    return {x: -(first.width + reading) | 0, y: 0};
  }
}
