/** Synthetic demonstration only; receives and returns unsigned integer bit patterns. */
export function add(inputs) {
  return BigInt.asUintN(64, inputs.left + inputs.right);
}
