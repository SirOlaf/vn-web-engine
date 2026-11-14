import test from 'node:test';
import assert from 'node:assert/strict';

test('WebGL draw target uploads a uniform only when its program holds other values', async () => {
  const {WebGLDrawTarget} = await import('../dist/graphics/webgl-draw.js');
  const uploads = [],
    names = new Map(),
    constants = new Map();
  let objects = 0;
  const gl = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(key)) {
          if (!constants.has(key)) constants.set(key, 0x9000 + constants.size);
          return constants.get(key);
        }
        if (key === 'checkFramebufferStatus') return () => gl.FRAMEBUFFER_COMPLETE;
        if (key === 'getParameter') return () => 16;
        if (key === 'getExtension' || key === 'getProgramInfoLog' || key === 'getShaderInfoLog')
          return () => null;
        if (key === 'isContextLost') return () => false;
        if (key === 'getAttribLocation')
          return (_p, name) => ['position', 'color', 'uv'].indexOf(name);
        if (key === 'getUniformLocation')
          return (program, name) => {
            const location = {program, name};
            names.set(location, name);
            return location;
          };
        if (key.startsWith('uniform'))
          return (location, ...values) =>
            uploads.push(
              `${location.program.id}:${names.get(location)}=${values.flatMap((v) => (ArrayBuffer.isView(v) ? [...v] : [v])).join(',')}`,
            );
        if (key.startsWith('create')) return () => ({id: ++objects});
        if (key.startsWith('get') || key.startsWith('is')) return () => true;
        return () => {};
      },
    },
  );
  const canvas = {width: 0, height: 0, getContext: () => gl},
    target = new WebGLDrawTarget(canvas, 8, 4, {direct: true}),
    image = {width: 2, height: 2, pixels: new Uint8Array(16)},
    triangle = (extra = {}) => ({
      kind: 'triangles',
      texture: 0,
      vertices: new Float32Array(27),
      discardTransparent: false,
      ...extra,
    }),
    draw = (...commands) => {
      uploads.length = 0;
      target.draw({sprites: [], commands}, () => image);
      return [...uploads];
    };
  const first = draw(triangle());
  assert.ok(
    first.some((u) => u.endsWith(':transform=false,0.25,0,0,0,0,-0.5,0,0,0,0,0,0,-1,1,0,1')),
  );
  assert.ok(first.some((u) => u.endsWith(':textureSize=2,2')));
  // The same draw again finds every uniform already set.
  assert.deepEqual(draw(triangle()), []);
  // Only the changed values reach GL, and -0 is not the cached 0.
  const parameters = new Float32Array(32);
  parameters[5] = -0;
  assert.deepEqual(
    draw(triangle({normalizedUV: true, parameters})).map((u) => u.replace(/^\d+:/, '')),
    ['textureSize=1,1', `parameters[0]=${[...parameters].join(',')}`],
  );
  // Another program keeps its own values.
  const other = draw(triangle({fragment: 'vec4 shade(vec4 s,vec4 t){return t;}'}));
  assert.ok(other.some((u) => u.endsWith(':depthClip=1')));
  assert.notEqual(other[0].split(':')[0], first[0].split(':')[0]);
});
