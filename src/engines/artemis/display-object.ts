import {artemisRevision} from './revision.js';
import type {ArtemisImageClip, ArtemisLayerPropertyPatch} from './layer-properties.js';

export interface ArtemisDisplayProperties {
  left: number;
  top: number;
  alpha: number;
  anchorx: number;
  anchory: number;
  xscale: number;
  yscale: number;
  rotate: number;
  reversex: boolean;
  reversey: boolean;
  visible: boolean;
}
export type ArtemisFloatTrig = (radians: number) => {readonly sin: number; readonly cos: number};
const epsilon = 2 ** -23;
const pi = Math.fround(Math.PI);
const f = Math.fround;
const product = (a: number, b: number) => f(a * b);
const sum = (a: number, b: number) => f(a + b);

/** Native CDisplayObject defaults and ordinary local transform, 0x1400a1060 / 0x1400a14b0. */
export class ArtemisDisplayObject {
  private readonly hash: string;
  private parentMatrix = new Float32Array([1, 0, 0, 0, 1, 0]);
  private world = new Float32Array([1, 0, 0, 0, 1, 0]);
  private matrixDirty = true;
  private stateRevision = 0;
  /** CLayer +0x168 (`clickablethreshold`, setter 0x1400a4960). Not a drawn property. */
  private threshold = 0;
  /** CLayer +0x16c (`draggable`, setter 0x1400a4970) and the drag area TRect<float> at
   * +0x170 (setter 0x1400a4980), zero after construction 0x1400a3640. Not drawn. */
  private drag = false;
  private area: ArtemisImageClip = {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
  private state: ArtemisDisplayProperties = {
    left: 0,
    top: 0,
    alpha: 1,
    anchorx: 0,
    anchory: 0,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    reversex: false,
    reversey: false,
    visible: true,
  };
  constructor(executableSha256: string) {
    this.hash = artemisRevision(executableSha256).executableSha256;
  }
  get properties(): Readonly<ArtemisDisplayProperties> {
    return {...this.state};
  }
  /** Property mutations invalidate dependent captures; accepted-parent updates do not. */
  get propertyRevision(): number {
    return this.stateRevision;
  }
  copy(): ArtemisDisplayObject {
    const result = new ArtemisDisplayObject(this.hash);
    result.state = {...this.state};
    result.parentMatrix = this.parentMatrix.slice();
    result.world = this.world.slice();
    result.matrixDirty = this.matrixDirty;
    result.stateRevision = this.stateRevision;
    result.threshold = this.threshold;
    result.drag = this.drag;
    result.area = this.area;
    return result;
  }
  get draggable(): boolean {
    return this.drag;
  }
  get dragArea(): Readonly<ArtemisImageClip> {
    return this.area;
  }
  get clickableThreshold(): number {
    return this.threshold;
  }
  /** Pixel test at the end of image hit test 0x14017b6a0, after the point is inside the
   * image: threshold 0 hits without reading the pixel; otherwise the pixel's alpha byte
   * must reach the threshold as an unsigned comparison (negative thresholds never hit). */
  hitsAlpha(alpha: () => number): boolean {
    return this.threshold === 0 || this.threshold >>> 0 <= alpha();
  }
  apply(patch: ArtemisLayerPropertyPatch): void {
    if (patch.clickablethreshold !== undefined) {
      if (patch.clickablethreshold !== (patch.clickablethreshold | 0))
        throw new Error('Invalid Artemis clickable threshold');
      this.threshold = patch.clickablethreshold;
    }
    if (patch.draggable !== undefined) this.drag = patch.draggable;
    if (patch.dragarea !== undefined) this.area = {...patch.dragarea};
    const next = {...this.state};
    for (const key of Object.keys(next) as (keyof ArtemisDisplayProperties)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof next[key] === 'boolean') {
        if (typeof value !== 'boolean') throw new Error('Invalid Artemis display flag');
      } else if (typeof value !== 'number' || !Number.isFinite(f(value)))
        throw new Error('Unsupported Artemis display value');
      Object.assign(next, {[key]: typeof value === 'number' ? f(value) : value});
    }
    const geometry = [
      'left',
      'top',
      'anchorx',
      'anchory',
      'xscale',
      'yscale',
      'rotate',
      'reversex',
      'reversey',
    ] as const;
    if (geometry.some((key) => next[key] !== this.state[key])) this.matrixDirty = true;
    if (
      (Object.keys(next) as (keyof ArtemisDisplayProperties)[]).some(
        (key) => next[key] !== this.state[key],
      )
    )
      this.stateRevision++;
    this.state = next;
  }
  /** Parent acceptance in 0x14015b440/0x14015adc0: retain all six coefficients
   * unless at least one float32 difference reaches FLT_EPSILON. Copy preserves it.
   * Memoizing unchanged geometry avoids repeating the pure float transform in JS. */
  worldMatrix(parent: Float32Array, trig?: ArtemisFloatTrig): Float32Array {
    if (parent.length !== 6 || !parent.every(Number.isFinite))
      throw new Error('Invalid Artemis parent matrix');
    if (!parent.every((value, index) => Math.abs(f(value - this.parentMatrix[index]!)) < epsilon)) {
      this.parentMatrix = new Float32Array(parent);
      this.matrixDirty = true;
    }
    if (this.matrixDirty) {
      this.world = new Float32Array(this.matrix(this.parentMatrix, trig));
      this.matrixDirty = false;
    }
    return this.world.slice();
  }
  /** Row-major [a,b,tx,c,d,ty]. Nonzero rotations require the native float trig owner. */
  matrix(
    parent: Float32Array = new Float32Array([1, 0, 0, 0, 1, 0]),
    trig?: ArtemisFloatTrig,
  ): Float32Array {
    if (parent.length !== 6 || !parent.every(Number.isFinite))
      throw new Error('Invalid Artemis parent matrix');
    const m = parent.slice(),
      p = this.state;
    const snap = () => {
      for (let i = 0; i < 6; i++) if (Math.abs(m[i]!) < epsilon) m[i] = 0;
    };
    const translate = (x: number, y: number) => {
      m[2] = sum(sum(product(x, m[0]!), product(y, m[1]!)), m[2]!);
      m[5] = sum(sum(product(x, m[3]!), product(y, m[4]!)), m[5]!);
      snap();
    };
    translate(p.left, p.top);
    translate(p.anchorx, p.anchory);
    const radians = product(f(p.rotate / 180), pi);
    if (radians !== 0 && !trig)
      throw new Error('Unsupported Artemis native float trigonometry owner');
    const rotation = radians === 0 ? {sin: 0, cos: 1} : trig!(radians);
    const sin = f(rotation.sin),
      cos = f(rotation.cos);
    if (!Number.isFinite(sin) || !Number.isFinite(cos))
      throw new Error('Invalid Artemis float trigonometry');
    const a = m[0]!,
      c = m[3]!;
    m[0] = sum(product(m[1]!, sin), product(a, cos));
    m[1] = f(product(m[1]!, cos) - product(a, sin));
    m[3] = sum(product(m[4]!, sin), product(c, cos));
    m[4] = f(product(m[4]!, cos) - product(c, sin));
    snap();
    m[0] = product(p.xscale, m[0]!);
    m[3] = product(p.xscale, m[3]!);
    m[1] = product(p.yscale, m[1]!);
    m[4] = product(p.yscale, m[4]!);
    snap();
    if (p.reversex) {
      m[0] = -m[0]!;
      m[3] = -m[3]!;
      snap();
    }
    if (p.reversey) {
      m[1] = -m[1]!;
      m[4] = -m[4]!;
      snap();
    }
    translate(-p.anchorx, -p.anchory);
    if (!m.every(Number.isFinite)) throw new Error('Unsupported Artemis display matrix overflow');
    return m;
  }
}

/** GPU quad multiplication with separate float32 products/additions. */
export function artemisDisplayPoint(
  matrix: Float32Array,
  x: number,
  y: number,
): readonly [number, number] {
  if (
    matrix.length !== 6 ||
    !matrix.every(Number.isFinite) ||
    ![x, y].every((n) => Number.isFinite(f(n)))
  )
    throw new Error('Invalid Artemis display point');
  return [
    sum(sum(product(f(x), matrix[0]!), product(f(y), matrix[1]!)), matrix[2]!),
    sum(sum(product(f(x), matrix[3]!), product(f(y), matrix[4]!)), matrix[5]!),
  ];
}
