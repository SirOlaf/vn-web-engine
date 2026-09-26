import type {CounterState} from './types.mjs';
export function bump(context: CounterState, value: number): number;
export function base(value: number): number;
export function alternate(value: number): number;
export function measureText(value: unknown): number;
export function measureList(value: unknown): number;
export function run(
  context: CounterState,
  value: number,
  chooseAlternate: boolean,
  opaqueValue: unknown,
): number;
export function swapLoop(count: number): number;
