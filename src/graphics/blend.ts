export type BlendFactor =
  | 'zero'
  | 'one'
  | 'source-color'
  | 'inverse-source-color'
  | 'source-alpha'
  | 'inverse-source-alpha'
  | 'destination-color'
  | 'inverse-destination-color'
  | 'destination-alpha'
  | 'inverse-destination-alpha';
export type BlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';
export interface BlendChannel {
  source: BlendFactor;
  destination: BlendFactor;
  operation: BlendOperation;
}
export interface BlendState {
  color: BlendChannel;
  alpha: BlendChannel;
}
