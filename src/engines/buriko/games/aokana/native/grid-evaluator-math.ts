import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {nativeGridEvaluatorFacingCosine} from '../bp/opcodes/native-math.js';
import {gridOutput} from './logical-grid-path.js';
import {truncateSplineInteger} from './spline.js';

function read(pointer: AokanaBpPointer | null, offset: number): number {
  if (pointer === null) throw new Error('Aokana grid evaluator null arithmetic operand');
  return pointerView({bytes: pointer.bytes, offset: pointer.offset + offset}, 4).getInt32(0, true);
}

/** 1400a7710: type 2/100 intentionally leave the second output DWORD unchanged. */
export function gridEvaluatorModifiers(
  output: AokanaBpPointer | null,
  type: number,
  source: AokanaBpPointer | null,
  target: AokanaBpPointer | null,
): number {
  const modifier = (record: AokanaBpPointer | null, flag: number, value: number): number =>
    read(record, flag) > 0 ? read(record, value) : 0;
  type |= 0;
  if (type === 0 || type === 1) {
    const delta = type * 16;
    gridOutput(
      output,
      (modifier(source, 0x134 + delta, 0x1b4 + delta) -
        modifier(source, 0x138 + delta, 0x1b8 + delta)) |
        0,
    );
    gridOutput(
      output,
      (modifier(target, 0x13c + delta, 0x1bc + delta) -
        modifier(target, 0x140 + delta, 0x1c0 + delta)) |
        0,
      4,
    );
  } else if (type === 2 || type === 0x100) {
    const delta = type === 2 ? 0 : 16;
    gridOutput(
      output,
      (modifier(source, 0x144 + delta, 0x1c4 + delta) -
        modifier(source, 0x148 + delta, 0x1c8 + delta)) |
        0,
    );
  } else {
    gridOutput(output, 0);
    gridOutput(output, 0, 4);
    return 0x90000005;
  }
  return 0;
}

/** 1400a7870: DWORD multiply/divide/clamp, then two wrapping QWORD multiplies and SAR 32. */
export function gridEvaluatorEffect(
  output: AokanaBpPointer | null,
  type: number,
  source: AokanaBpPointer | null,
  additions: AokanaBpPointer | null,
  sourceModifier: number,
  target: AokanaBpPointer | null,
  targetModifier: number,
  affinity: number,
  facing: number,
): number {
  type |= 0;
  sourceModifier |= 0;
  targetModifier |= 0;
  if (type !== 0 && type !== 1 && type !== 2) {
    gridOutput(output, 0);
    return 0x90000005;
  }
  let sum = 0n;
  // Type 2 reads lanes 3, 0, 2, 1 in assembly; no target pointer is dereferenced.
  const lanes = type === 2 ? [3, 0, 2, 1] : [0, 1, 2, 3];
  for (const lane of lanes) {
    const offset = (type === 0 ? 0 : 64) + lane * 16;
    const augmented = (read(source, offset + 4) + read(additions, lane * 4) + sourceModifier) | 0;
    if (type === 2) {
      sum += BigInt(augmented);
    } else {
      const divisor = Math.max(1, read(target, offset + 8));
      const quotient = Math.trunc(Math.imul(augmented, read(source, offset)) / divisor);
      const result = (quotient - read(target, offset + 12) - targetModifier) | 0;
      sum += BigInt(Math.max(0, result));
    }
  }
  const product = BigInt.asIntN(
    64,
    BigInt.asIntN(64, sum * BigInt(facing | 0)) * BigInt(affinity | 0),
  );
  gridOutput(output, Number(BigInt.asIntN(32, product >> 32n)));
  return 0;
}

/** 1400a7b80 with the fixed native cosine and inclusive 2^-14 integer snap. */
export function gridEvaluatorFacing(angle: number, multiplier: number): number {
  let cosine = nativeGridEvaluatorFacingCosine(angle);
  const floor = Math.floor(cosine),
    fraction = cosine - floor;
  if (1 - 2 ** -14 <= fraction) cosine = Math.ceil(cosine);
  else if (fraction <= 2 ** -14) cosine = floor;
  return truncateSplineInteger(((1 - cosine) * multiplier + cosine) * 65536);
}

/** 1400a7c10 cyclic affinity, including native signed remainder for wrapped sums. */
export function gridEvaluatorAffinity(
  source: number,
  target: number,
  typeCount: number | undefined,
  weights: readonly number[],
): number {
  source |= 0;
  target |= 0;
  if (target < 0) return 0;
  if (typeCount === undefined)
    throw new Error('Aokana grid evaluator uninitialized affinity type count');
  if (target >= typeCount || source < 0 || source >= typeCount) return 0;
  if (target === ((source + 1) | 0) % typeCount) return weights[0]! | 0;
  if (target === ((source - 1 + typeCount) | 0) % typeCount) return weights[2]! | 0;
  return weights[1]! | 0;
}

/** 1400a7af0, the packed 20-byte request derived from one 0x834-byte actor record. */
export function gridEvaluatorAbilityRequest(
  output: AokanaBpPointer | null,
  record: AokanaBpPointer | null,
  ability: number,
): number {
  ability |= 0;
  if (ability === 0) {
    gridOutput(output, 0);
    for (let i = 0; i < 3; i++) gridOutput(output, read(record, 0x254 + i * 4), 4 + i * 4);
    gridOutput(output, 0, 16);
    return 0;
  }
  if ((ability - 1) >>> 0 >= 16) return 0x90000004;
  const offset = (ability - 1) * 0x58;
  if (read(record, 0x2b4 + offset) === 0) return 0x90000004;
  gridOutput(output, read(record, 0x2b8 + offset));
  for (let i = 0; i < 4; i++) gridOutput(output, read(record, 0x2dc + offset + i * 4), 4 + i * 4);
  return 0;
}
