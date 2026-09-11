import type {NoahState} from './noah-state.js';
import type {BlendChannel, BlendState} from '../../../../../graphics/blend.js';
/** 140077bb0, and the public ushort selector mapping in 140069330. */
export function nativeBlend(selector = 0): BlendState {
  const c = selector & 255,
    a = (selector >>> 8) & 255;
  const colors: BlendChannel[] = [
    {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
    {source: 'one', destination: 'zero', operation: 'add'},
    {source: 'source-alpha', destination: 'one', operation: 'add'},
    {source: 'source-alpha', destination: 'one', operation: 'subtract'},
    {source: 'source-alpha', destination: 'one', operation: 'reverse-subtract'},
    {source: 'one', destination: 'one', operation: 'add'},
    {source: 'one', destination: 'one', operation: 'subtract'},
    {source: 'one', destination: 'one', operation: 'reverse-subtract'},
    {source: 'zero', destination: 'one', operation: 'add'},
  ];
  const alphas: BlendChannel[] = [
    {source: 'one', destination: 'one', operation: 'max'},
    {source: 'source-alpha', destination: 'inverse-source-alpha', operation: 'add'},
    {source: 'one', destination: 'zero', operation: 'add'},
    {source: 'zero', destination: 'one', operation: 'add'},
    {source: 'one', destination: 'one', operation: 'add'},
    {source: 'one', destination: 'one', operation: 'subtract'},
    {source: 'one', destination: 'one', operation: 'reverse-subtract'},
    {source: 'one', destination: 'one', operation: 'min'},
  ];
  return {color: colors[c] ?? colors[0]!, alpha: alphas[a] ?? alphas[0]!};
}

/** Global flags consumed by 140069ae0, 140069890 and 14006b6c0. */
export function nativeSampler(s: NoahState) {
  const flags = s.get(0x586a54);
  return {
    filter: (flags & 0xf0000) === 0x10000 ? ('nearest' as const) : ('linear' as const),
    wrapS:
      (flags & 0x300) === 0x100
        ? ('repeat' as const)
        : (flags & 0x300) === 0x200
          ? ('mirror' as const)
          : ('clamp' as const),
    wrapT:
      (flags & 0xc00) === 0x400
        ? ('repeat' as const)
        : (flags & 0xc00) === 0x800
          ? ('mirror' as const)
          : ('clamp' as const),
  };
}
