import {artemisRevision} from './revision.js';
import type {ArtemisTextBlock} from './text-block.js';

export interface ArtemisPositionedBlock<T> {
  readonly block: ArtemisTextBlock<T>;
  readonly x: number;
  readonly y: number;
}
export interface ArtemisTextLineSnapshot<T> {
  readonly width: number;
  readonly height: number;
  readonly characterCount: number;
  readonly blocks: readonly ArtemisPositionedBlock<T>[];
}
const f = Math.fround;
/** 14a9a0/197f40/197fd0/198080 line storage, pop/reflow and alignment.
 * The layer owns wrapping/indent stacks and all block/display resources.
 */
export class ArtemisTextLine<T> {
  private readonly blocks: ArtemisTextBlock<T>[] = [];
  private positions: {x: number; y: number}[] = [];
  private lineWidth = 0;
  private lineHeight = 0;
  private count = 0;
  constructor(private readonly hash: string) {
    artemisRevision(hash);
  }
  copy(
    copyBlock: (block: ArtemisTextBlock<T>, index: number) => ArtemisTextBlock<T> = (block) =>
      block,
  ): ArtemisTextLine<T> {
    const copied = new ArtemisTextLine<T>(this.hash);
    copied.blocks.push(...this.blocks.map(copyBlock));
    copied.positions = this.positions.map((position) => ({...position}));
    copied.lineWidth = this.lineWidth;
    copied.lineHeight = this.lineHeight;
    copied.count = this.count;
    return copied;
  }
  get width(): number {
    return this.lineWidth;
  }
  get height(): number {
    return this.lineHeight;
  }
  get characterCount(): number {
    return this.count;
  }
  get length(): number {
    return this.blocks.length;
  }
  append(block: ArtemisTextBlock<T>): void {
    if (
      this.blocks.length >= 10000 ||
      !Number.isFinite(block.width) ||
      !Number.isFinite(block.height)
    )
      throw Error('Unsupported Artemis text line block');
    this.lineWidth = f(this.lineWidth + f(block.width));
    if (this.lineHeight <= block.height && this.lineHeight !== block.height)
      this.lineHeight = f(block.height);
    this.count = (this.count + block.main.length) | 0;
    this.blocks.push(block);
    this.positions.push({x: 0, y: 0});
  }
  /** Transfers this line's logical block reference back to its wrapping owner. */
  pop(): ArtemisTextBlock<T> {
    const block = this.blocks.pop();
    if (!block) throw Error('Artemis text line underflow');
    this.positions.pop();
    this.lineWidth = f(this.lineWidth - block.width);
    this.count = (this.count - block.main.length) | 0;
    this.lineHeight = 0;
    for (const remaining of this.blocks)
      if (this.lineHeight < remaining.height) this.lineHeight = f(remaining.height);
    return block;
  }
  finalize(
    containerWidth: number,
    align: 'left' | 'center' | 'right' | 'equalize',
    emptyHeight: number,
  ): ArtemisTextLineSnapshot<T> {
    if (
      !Number.isFinite(containerWidth) ||
      !Number.isFinite(emptyHeight) ||
      !Number.isFinite(f(containerWidth)) ||
      !Number.isFinite(f(emptyHeight))
    )
      throw Error('Unsupported Artemis text line geometry');
    if (!['left', 'center', 'right', 'equalize'].includes(align))
      throw Error('Unsupported Artemis text line alignment');
    if (this.lineHeight === 0) this.lineHeight = f(emptyHeight);
    const equalize = align === 'equalize' && this.blocks.length >= 2;
    const gap = equalize ? f(f(f(containerWidth) - this.lineWidth) / f(this.blocks.length - 1)) : 0;
    let x =
      align === 'center'
        ? f(f(f(containerWidth) - this.lineWidth) * 0.5)
        : align === 'right'
          ? f(f(containerWidth) - this.lineWidth)
          : 0;
    const blocks = this.blocks.map((block) => {
      const placed = Object.freeze({block, x, y: f(this.lineHeight - block.height)});
      x = equalize ? f(f(x + gap) + block.width) : f(x + block.width);
      return placed;
    });
    this.positions = blocks.map(({x, y}) => ({x, y}));
    return this.snapshot();
  }
  /** Copies stored placement without applying finalization or reserving empty height. */
  snapshot(): ArtemisTextLineSnapshot<T> {
    return Object.freeze({
      width: this.lineWidth,
      height: this.lineHeight,
      characterCount: this.count,
      blocks: Object.freeze(
        this.blocks.map((block, index) => Object.freeze({block, ...this.positions[index]!})),
      ),
    });
  }
}
