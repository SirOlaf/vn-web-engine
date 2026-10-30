import assert from 'node:assert/strict';

/** Alternate D3D11 contract implementation; records synthetic draws, never GPU pixels. */
export function nativeHost({recordAll = false} = {}) {
  const slots = new Map();
  const created = [],
    calls = [],
    bindings = new Map();
  let failed = null;
  let depthState = null,
    stencilReference = 0;
  const object = (kind, desc = null, data = null) => {
    const value = {
      kind,
      desc,
      data: data?.slice(),
      references: 1,
      addRef() {
        assert.ok(this.references > 0);
        return ++this.references;
      },
      release() {
        assert.ok(this.references > 0);
        return --this.references;
      },
      getDesc: () => desc,
      getType: () => 3,
    };
    created.push(value);
    return value;
  };
  const factory = (kind, desc, data) =>
    failed === kind
      ? {hr: -1, value: null}
      : (() => {
          const value = object(kind, desc, data);
          if (recordAll) calls.push({method: kind, value});
          return {hr: 0, value};
        })();
  const device = object('device');
  for (const kind of [
    'createInputLayout',
    'createVertexShader',
    'createPixelShader',
    'createBlendState',
    'createDepthStencilState',
    'createRasterizerState',
    'createSamplerState',
  ])
    device[kind] = (desc) => factory(kind, desc);
  device.createBuffer = (desc, data) => factory('buffer', desc, data?.data);
  device.createTexture2D = (desc, data) => factory('texture', desc, data?.[0].data);
  for (const [name, kind] of [
    ['createShaderResourceView', 'srv'],
    ['createRenderTargetView', 'rtv'],
    ['createDepthStencilView', 'dsv'],
  ])
    device[name] = (source, desc) => {
      const result = factory(kind, desc);
      if (result.value) {
        source.addRef();
        const view = result.value,
          release = view.release;
        view.getResource = () => {
          source.addRef();
          return source;
        };
        view.release = () => {
          const count = release.call(view);
          if (count === 0) source.release();
          return count;
        };
      }
      return result;
    };
  const context = object('context');
  const clear = () => {
    for (const values of bindings.values()) for (const value of values) value.release();
    bindings.clear();
    slots.clear();
    depthState = null;
    stencilReference = 0;
  };
  const releaseContext = context.release;
  context.release = () => {
    const count = releaseContext.call(context);
    if (count === 0) clear();
    return count;
  };
  const bind = (key, values) => {
    const next = values.filter(Boolean);
    for (const value of next) value.addRef();
    for (const value of bindings.get(key) ?? []) value.release();
    bindings.set(key, next);
  };
  for (const name of [
    'psSetShaderResources',
    'psSetSamplers',
    'vsSetConstantBuffers',
    'psSetConstantBuffers',
  ])
    context[name] = (slot, values) => {
      slots.set(name + slot, [...values]);
      bind(name + slot, values);
      if (recordAll) calls.push({method: name, slot, values: [...values]});
    };
  for (const name of [
    'iaSetInputLayout',
    'vsSetShader',
    'psSetShader',
    'rsSetState',
    'omSetBlendState',
    'omSetDepthStencilState',
  ])
    context[name] = (value) => bind(name, [value]);
  context.omSetRenderTargets = (views, depth) => {
    bind('targets', [...views, depth]);
    if (recordAll) calls.push({method: 'omSetRenderTargets', views: [...views], depth});
  };
  context.omSetDepthStencilState = (value, reference) => {
    bind('omSetDepthStencilState', [value]);
    depthState = value;
    stencilReference = reference >>> 0;
    calls.push({method: 'depthStencil', desc: value?.getDesc(), reference: stencilReference});
  };
  context.omGetDepthStencilState = () => {
    depthState?.addRef();
    return {state: depthState, stencilRef: stencilReference};
  };
  context.iaSetVertexBuffers = (slot, values, strides, offsets) => {
    bind('vertices' + slot, values);
    calls.push({method: 'vertices', bytes: values[0].data.slice(), strides, offsets});
  };
  for (const name of [
    'rsSetViewports',
    'rsSetScissorRects',
    'clearRenderTargetView',
    'clearDepthStencilView',
    'iaSetPrimitiveTopology',
  ])
    context[name] = (...args) => calls.push({method: name, args});
  context.copySubresourceRegion = (...args) => calls.push({method: 'copySubresourceRegion', args});
  context.draw = (...args) =>
    calls.push({
      method: 'draw',
      args,
      source: slots.get('psSetShaderResources0')?.slice() ?? [],
      target: bindings.get('targets')?.[0],
      blend: bindings.get('omSetBlendState')?.[0]?.desc?.renderTarget?.[0],
      constants: bindings.get('psSetConstantBuffers0')?.[0]?.data?.slice(),
    });
  context.updateSubresource = (buffer, _sub, _box, data) => {
    buffer.data = data.slice();
  };
  context.clearState = clear;
  return {
    device,
    context,
    created,
    calls,
    fail: (kind) => {
      failed = kind;
    },
  };
}

export function shaderStandins({constants = false} = {}) {
  const reflection = (stage) => ({
    stage,
    flags: 0,
    creator: 'synthetic',
    buffers: constants
      ? [
          {
            name: '$Globals',
            bufferType: 0,
            slot: 0,
            bytes: 160,
            variables: [
              ['modelViewProj', 0, 64],
              ['screenMul', 64, 8],
              ['alphaRef', 72, 4],
              ['filterColor', 80, 16],
              ['alphaMulAdd', 96, 16],
              ['screenMulOffset', 112, 16],
              ['blendParam', 128, 16],
            ].map(([name, offset, bytes]) => ({name, offset, bytes})),
          },
        ]
      : [],
    resources: [],
  });
  return {
    vertex: Array.from({length: 12}, (_, i) => Uint8Array.of(i)),
    pixel: Array.from({length: 2077}, () => new Uint8Array()),
    vertexReflection: Array.from({length: 12}, () => reflection('vertex')),
    pixelReflection: Array.from({length: 2077}, () => reflection('pixel')),
    inputLayouts: Array.from({length: 12}, () => []),
  };
}
