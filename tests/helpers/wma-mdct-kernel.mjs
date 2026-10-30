import {WMA_AUDIO_WASM_BINARY} from '../../dist/formats/wma/wasm-binary.js';

/** The same bounded pointer plan used by the Rust audio core; synthetic buffers only. */
export function mdctKernel() {
  const n = new WebAssembly.Instance(
    new WebAssembly.Module(Buffer.from(WMA_AUDIO_WASM_BINARY, 'base64')),
    {},
  ).exports;
  n.memory.grow(16);
  let cursor = (Number(n.__heap_base.value) + 15) & ~15;
  const allocate = (source, Type) => {
    const view = new Type(
      n.memory.buffer,
      cursor,
      typeof source === 'number' ? source : source.length,
    );
    cursor = (cursor + view.byteLength + 15) & ~15;
    if (typeof source !== 'number') view.set(source);
    return view;
  };
  const input = allocate(2048, Float32Array),
    output = allocate(4096, Float32Array);
  return {
    createPlan(transform) {
      const plan = transform.copyPlan({
        i32: (n) => allocate(n, Int32Array),
        f32: (n) => allocate(n, Float32Array),
      });
      return {
        decode(source, full = true) {
          input.set(source);
          output.fill(NaN);
          n.wma_imdct(plan.byteOffset, input.byteOffset, output.byteOffset, Number(full));
          return output.slice(0, transform.length * (full ? 2 : 1));
        },
      };
    },
  };
}
