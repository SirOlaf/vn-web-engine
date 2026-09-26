/** Ordinary synthetic adapters used by the CFG example; no native code or engine state. */
export function bump(context, value) {
  context.count++;
  return (value + context.count) | 0;
}
export function base(value) {
  return (value + 1) | 0;
}
export function alternate(value) {
  return (value + 10) | 0;
}
export function measureText(value) {
  if (typeof value !== 'string')
    throw new TypeError('Expected the explicitly selected text representation');
  return value.length >>> 0;
}
export function measureList(value) {
  if (!Array.isArray(value))
    throw new TypeError('Expected the explicitly selected list representation');
  return value.length >>> 0;
}
export function run(context, value, chooseAlternate, opaqueValue) {
  const seed = bump(context, value);
  const chosen = chooseAlternate ? (seed + 1) | 0 : seed;
  return (alternate(chosen) + base(chosen) + alternate(chosen) + measureText(opaqueValue)) | 0;
}
export function swapLoop(count) {
  let a = 10,
    b = 20;
  for (let i = 0; i < count; i++) [a, b] = [b, a];
  return a;
}
