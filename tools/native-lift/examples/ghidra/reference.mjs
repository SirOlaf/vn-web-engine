// Independent ordinary scalar references for the invented Ghidra fixtures.
// These functions describe results; no x86 instructions are executed.
export function add(value) {
  return (value + 5) | 0;
}
export function branch(value) {
  return (value + (value < 1 ? -2 : 6)) | 0;
}
export function loop(value) {
  let total = 0;
  for (let current = value; current > 0; current--) total = (total + current) | 0;
  return total;
}
