import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSm4Program} from '../dist/graphics/d3d11-shader/bytecode.js';
import {parseSm4Signature} from '../dist/graphics/d3d11-shader/signature.js';
import {translateSm4ToGlsl} from '../dist/graphics/d3d11-shader/glsl.js';
import {parseSm4GlslShader, linkSm4GlslPrograms} from '../dist/graphics/d3d11-shader/program.js';
import {
  sm4SyntheticFixtures,
  shaderWords,
  instruction,
  destination,
  source,
  sampleResource,
  samplerOperand,
  sm4SyntheticPipeline,
} from '../tools/lib/sm4-synthetic-fixtures.mjs';
import {parseDxbcContainer} from '../dist/graphics/d3d11-shader/container.js';
import {extractEmoteX64ShaderBlobs} from '../dist/native/emotedriver/runtime/render/shaders.js';

function container() {
  const bytes = new Uint8Array(72),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DXBC'));
  view.setUint16(20, 1, true);
  view.setUint32(24, bytes.length, true);
  view.setUint32(28, 2, true);
  view.setUint32(32, 56, true); // Table order deliberately differs from file order.
  view.setUint32(36, 40, true);
  for (const [offset, tag, value] of [
    [40, 'RDEF', 9],
    [56, 'SHDR', 17],
  ]) {
    bytes.set(new TextEncoder().encode(tag), offset);
    view.setUint32(offset + 4, 8, true);
    bytes.fill(value, offset + 8, offset + 16);
  }
  return bytes;
}

test('DXBC parts retain table order and borrow the exact byte view', () => {
  const backing = new Uint8Array(80),
    bytes = backing.subarray(3, 75);
  bytes.set(container());
  const result = parseDxbcContainer(bytes);
  assert.equal(result.major, 1);
  assert.equal(result.minor, 0);
  assert.deepEqual(
    result.parts.map((p) => [p.kind, p.offset]),
    [
      ['SHDR', 56],
      ['RDEF', 40],
    ],
  );
  assert.equal(result.parts[0].data.buffer, backing.buffer);
  assert.equal(result.parts[0].data.byteOffset, 3 + 64);
  assert.deepEqual([...result.parts[0].data], Array(8).fill(17));
  bytes[64] = 21;
  bytes[4] = 7;
  assert.equal(result.parts[0].data[0], 21);
  assert.equal(result.digest[0], 7);
});

test('DXBC rejects invalid envelopes and overlapping or truncated parts before reading payloads', () => {
  assert.throws(() => parseDxbcContainer(new Uint8Array(31)));
  const corrupt = (change) => {
    const bytes = container();
    change(new DataView(bytes.buffer), bytes);
    assert.throws(() => parseDxbcContainer(bytes));
  };
  corrupt((v, b) => b.fill(0, 0, 4));
  corrupt((v) => v.setUint16(20, 2, true));
  corrupt((v) => v.setUint16(22, 1, true));
  corrupt((v) => v.setUint32(24, 71, true));
  corrupt((v) => v.setUint32(28, 0xffffffff, true));
  corrupt((v) => v.setUint32(28, 9, true));
  corrupt((v) => v.setUint32(32, 0, true));
  corrupt((v) => v.setUint32(32, 0xffffffff, true));
  corrupt((v) => v.setUint32(32, 40, true));
  corrupt((v) => v.setUint32(44, 9, true)); // First file part overlaps the next header.
  corrupt((v) => v.setUint32(60, 9, true));
});

test('the x64 embedded-shader reader refuses bytes outside its exact DLL identity', () => {
  assert.equal(extractEmoteX64ShaderBlobs(new Uint8Array()), null);
  assert.equal(extractEmoteX64ShaderBlobs(container()), null);
});

function program(instructions, version = 0x40) {
  const backing = new Uint8Array(3 + (instructions.length + 2) * 4);
  const bytes = backing.subarray(3),
    view = new DataView(backing.buffer, 3);
  [version, instructions.length + 2, ...instructions].forEach((value, i) =>
    view.setUint32(i * 4, value, true),
  );
  return bytes;
}

test('SM4 decodes unaligned program bytes, masked registers and exact immediate bit patterns', () => {
  const p = parseSm4Program(
    program(
      [
        0x02000068,
        4, // dcl_temps4
        0x08000036,
        0x00102032,
        0,
        0x00004002,
        0x80000000,
        0x7fc00123,
        0x3f800000,
        0xffffffff,
        0x0100003e, // ret
      ],
      0x10040,
    ),
  );
  assert.equal(p.stage, 'vertex');
  assert.deepEqual(
    p.instructions.map((i) => [i.offset, i.opcode]),
    [
      [2, 104],
      [4, 54],
      [12, 62],
    ],
  );
  assert.deepEqual(p.instructions[0].data, [4]);
  const [destination, literal] = p.instructions[1].operands;
  assert.equal(destination.type, 2);
  assert.deepEqual(destination.components, [0, 1]);
  assert.equal(destination.selectionMode, 'mask');
  assert.deepEqual(destination.indices, [{immediate: [0], relative: null}]);
  assert.deepEqual(literal.immediate, [0x80000000, 0x7fc00123, 0x3f800000, 0xffffffff]);
});

test('SM4 retains relative indexing, source modifiers, swizzles and64-bit index words', () => {
  const p = parseSm4Program(
    program([
      0x09000036, 0x001020f2, 0, 0x862081b6, 0x41, 0, 2, 0x0010000a, 3, 0x06000036, 0x001020f2, 0,
      0x00508e46, 0xffffffff, 0x87654321, 0x0100003e,
    ]),
  );
  const source = p.instructions[0].operands[1];
  assert.equal(source.type, 8);
  assert.deepEqual(source.extended, [0x41]);
  assert.equal(source.selectionMode, 'swizzle');
  assert.deepEqual(source.components, [3, 2, 1, 0]);
  assert.deepEqual(source.indices[0], {immediate: [0], relative: null});
  assert.deepEqual(source.indices[1].immediate, [2]);
  assert.equal(source.indices[1].relative.selectionMode, 'select');
  assert.deepEqual(source.indices[1].relative.components, [0]);
  assert.deepEqual(source.indices[1].relative.indices, [{immediate: [3], relative: null}]);
  assert.deepEqual(p.instructions[1].operands[1].indices, [
    {immediate: [0xffffffff, 0x87654321], relative: null},
  ]);
});

test('SM4 distinguishes custom-data lengths from instruction extension flags', () => {
  const p = parseSm4Program(program([0x1800 + 53, 5, 0xffffffff, 0x80000000, 0, 0x8200003e, 0]));
  assert.equal(p.instructions[0].customClass, 3);
  assert.deepEqual(p.instructions[0].data, [0xffffffff, 0x80000000, 0]);
  // Bit31 begins an extension chain only on ordinary instruction tokens.
  assert.equal(p.instructions[1].opcode, 62);
});

test('SM4 rejects malformed instructions before crossing their operand boundaries', () => {
  for (const bytes of [
    new Uint8Array(7),
    program([], 0x50),
    program([], 0x20040),
    program([0x0100007f]),
    program([0x0000003e]),
    program([0x0200003e]),
    program([53, 1]),
    program([53, 99]),
    program([0x01000036, 0x0100003e]),
    program([0x0200003e, 1]),
    program([0x8100003e]),
    program([0x04000036, 0x001020f2, 0, 3]),
    program([0x04000036, 0x001020f2, 0, 14]),
    program([0x05000036, 0x001020f2, 0, 0x01500001, 0]),
  ])
    assert.throws(() => parseSm4Program(bytes));
  const badLength = program([0x0100003e]);
  new DataView(badLength.buffer, badLength.byteOffset).setUint32(4, 99, true);
  assert.throws(() => parseSm4Program(badLength), /length/);
});

function signature() {
  const backing = new Uint8Array(3 + 76),
    bytes = backing.subarray(3),
    view = new DataView(backing.buffer, 3);
  view.setUint32(0, 2, true);
  view.setUint32(4, 16, true);
  for (const [offset, index, mask, readWrite] of [
    [16, 0, 3, 3],
    [40, 1, 12, 4],
  ]) {
    view.setUint32(offset, 64, true);
    view.setUint32(offset + 4, index, true);
    view.setUint32(offset + 12, 3, true);
    view.setUint32(offset + 16, 1, true);
    view.setUint8(offset + 20, mask);
    view.setUint8(offset + 21, readWrite);
  }
  bytes.set(new TextEncoder().encode('TeXcOoRd\0'), 64);
  return bytes;
}

test('SM4 signatures retain shared names, register masks and serialized semantic indices', () => {
  const bytes = signature(),
    p = parseSm4Signature(bytes);
  assert.deepEqual(p, [
    {
      semanticName: 'TeXcOoRd',
      semanticIndex: 0,
      systemValue: 0,
      componentType: 3,
      register: 1,
      mask: 3,
      readWriteMask: 3,
    },
    {
      semanticName: 'TeXcOoRd',
      semanticIndex: 1,
      systemValue: 0,
      componentType: 3,
      register: 1,
      mask: 12,
      readWriteMask: 4,
    },
  ]);
  bytes.fill(0);
  assert.equal(p[0].semanticName, 'TeXcOoRd');
  assert.deepEqual(parseSm4Signature(new Uint8Array(8)), []);
});

test('SM4 signatures reject truncated tables, invalid names, unordered registers and non-component mask bits', () => {
  assert.throws(() => parseSm4Signature(new Uint8Array(7)));
  for (const mutate of [
    (v) => v.setUint32(0, 4097, true),
    (v) => v.setUint32(4, 0, true),
    (v) => v.setUint32(4, 40, true),
    (v) => v.setUint32(16, 99, true),
    (v, b) => b.fill(65, 64),
    (v) => v.setUint32(56, 0, true),
    (v) => v.setUint8(36, 0x80),
    (v) => v.setUint8(37, 0x80),
  ]) {
    const bytes = signature();
    mutate(new DataView(bytes.buffer, bytes.byteOffset), bytes);
    assert.throws(() => parseSm4Signature(bytes));
  }
  const oversized = new Uint8Array(64 + 4098);
  oversized.set(signature().subarray(0, 64));
  oversized.fill(65, 64);
  oversized[oversized.length - 1] = 0;
  assert.throws(() => parseSm4Signature(oversized), /oversized/);
  oversized[64 + 4096] = 0;
  assert.equal(parseSm4Signature(oversized)[0].semanticName.length, 4096);
});

const decodeWords = (words) => {
  const bytes = new Uint8Array(words.length * 4),
    view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return parseSm4Program(bytes);
};

test('SM4 GLSL plans separate resource/sampler pairs and preserve raw constant-buffer ownership metadata', () => {
  const fixtures = sm4SyntheticFixtures();
  for (const test of fixtures) {
    const parsed = decodeWords(test.words),
      compiled = translateSm4ToGlsl(parsed);
    assert.deepEqual(compiled, translateSm4ToGlsl(decodeWords(test.words.slice())));
    assert.equal(compiled.stage, 'pixel');
    assert.equal(compiled.entry, 'sm4_ps');
  }
  const sampling = translateSm4ToGlsl(
    decodeWords(fixtures.find((c) => c.name === 'independent-sampler-pairs').words),
  );
  assert.deepEqual(sampling.samples, [
    {resource: 0, sampler: 0, uniform: 'sm4_ps_t0_s0'},
    {resource: 0, sampler: 1, uniform: 'sm4_ps_t0_s1'},
  ]);
  const constants = translateSm4ToGlsl(
    decodeWords(fixtures.find((c) => c.name === 'constant-buffer-zero-fill').words),
  );
  assert.deepEqual(constants.constantBuffers, [{slot: 0, vectors: 2, uniform: 'sm4_ps_cb0'}]);
});

test('SM4 GLSL supports disjoint packed declarations without allowing overlapping register components', () => {
  const words = shaderWords({body: [instruction(54, [destination(2, 0), source(1, 0)])]}),
    parsed = decodeWords(words);
  const input = parsed.instructions.find((i) => i.opcode === 98),
    output = parsed.instructions.find((i) => i.opcode === 101);
  const split = (entry, bits) => ({...entry, operands: [{...entry.operands[0], components: bits}]});
  parsed.instructions.splice(
    parsed.instructions.indexOf(input),
    1,
    split(input, [0, 1]),
    split(input, [2, 3]),
  );
  parsed.instructions.splice(
    parsed.instructions.indexOf(output),
    1,
    split(output, [0, 1]),
    split(output, [2, 3]),
  );
  const compiled = translateSm4ToGlsl(parsed);
  assert.deepEqual(
    compiled.inputs.map((i) => [i.register, i.mask]),
    [
      [0, 3],
      [0, 12],
    ],
  );
  assert.deepEqual(
    compiled.outputs.map((i) => [i.register, i.mask]),
    [
      [0, 3],
      [0, 12],
    ],
  );
  parsed.instructions.unshift(split(input, [0]));
  assert.throws(() => translateSm4ToGlsl(parsed), /overlapping/);
});

test('SM4 GLSL refuses unsupported shader effects before producing an executable plan', () => {
  const sample = decodeWords(
    shaderWords({
      stage: 'vertex',
      resources: [0],
      samplers: [0],
      body: [
        instruction(69, [destination(2, 0), source(1, 0), sampleResource(0), samplerOperand(0)]),
      ],
    }),
  );
  assert.throws(() => translateSm4ToGlsl(sample), /sample outside pixel/);
  const parsed = decodeWords(
    shaderWords({body: [instruction(54, [destination(2, 0), source(1, 0)])]}),
  );
  parsed.instructions.find((i) => i.opcode === 54).controls = 2;
  assert.throws(() => translateSm4ToGlsl(parsed), /controls/);
  const missing = decodeWords(
    shaderWords({body: [instruction(54, [destination(2, 0), source(1, 1)])]}),
  );
  assert.throws(() => translateSm4ToGlsl(missing), /undeclared input/);
});

test('SM4 stage interfaces own input bytes and link packed components at their native register locations', () => {
  const fixture = sm4SyntheticPipeline(true);
  const vertex = parseSm4GlslShader(fixture.vertex, 'vertex');
  const pixel = parseSm4GlslShader(fixture.pixel, 'pixel');
  const linked = linkSm4GlslPrograms(vertex, pixel);
  fixture.vertex.fill(0);
  fixture.pixel.fill(0);
  assert.deepEqual(linkSm4GlslPrograms(vertex, pixel), linked);
  assert.deepEqual(linked.attributes, [
    {name: 'sm4_a0', register: 0, location: 0},
    {name: 'sm4_a1', register: 1, location: 1},
  ]);
  assert.ok(Object.isFrozen(vertex.code.inputs[0]));
  assert.ok(Object.isFrozen(pixel.inputs));
  const mismatched = {
    ...pixel,
    inputs: pixel.inputs.map((p) => (p.semanticIndex === 1 ? {...p, register: 2} : p)),
  };
  assert.throws(() => linkSm4GlslPrograms(vertex, mismatched), /incompatible/);
  assert.throws(() => linkSm4GlslPrograms(pixel, vertex), /pipeline stages/);
});

test('SM4 unclipped-depth programs replace only the GL position depth', () => {
  const fixture = sm4SyntheticPipeline(true);
  const vertex = parseSm4GlslShader(fixture.vertex, 'vertex');
  const depthReader = parseSm4GlslShader(fixture.pixel, 'pixel');
  assert.throws(
    () => linkSm4GlslPrograms(vertex, depthReader, 0, 0, 0, true),
    /pixel depth with unclipped depth/,
  );
  // E-mote pixel shaders read SV_Position.xy only.
  const pixel = {
    ...depthReader,
    code: {
      ...depthReader.code,
      inputs: depthReader.code.inputs.map((p) => (p.systemValue === 1 ? {...p, mask: 3} : p)),
    },
  };
  const native = linkSm4GlslPrograms(vertex, pixel),
    unclipped = linkSm4GlslPrograms(vertex, pixel, 0, 0, 0, true),
    clipped = 'gl_Position=vec4(position.xy,2.0*position.z-position.w,position.w);';
  assert.ok(native.vertex.includes(clipped));
  assert.equal(
    unclipped.vertex,
    native.vertex.replace(clipped, 'gl_Position=vec4(position.xy,0.0,position.w);'),
  );
  assert.equal(unclipped.fragment, native.fragment);
  assert.deepEqual(unclipped.attributes, native.attributes);
});

test('SM4 unorm registers read raw B8G8R8A8 bytes as the float bits JavaScript stores for byte / 255', () => {
  const fixture = sm4SyntheticPipeline(true);
  const vertex = parseSm4GlslShader(fixture.vertex, 'vertex');
  const pixel = parseSm4GlslShader(fixture.pixel, 'pixel');
  const native = linkSm4GlslPrograms(vertex, pixel),
    unorm = linkSm4GlslPrograms(vertex, pixel, 0, 0, 0, false, 0b10);
  assert.equal(linkSm4GlslPrograms(vertex, pixel, 0, 0, 0, false, 0b100).vertex, native.vertex);
  assert.equal(unorm.fragment, native.fragment);
  assert.deepEqual(unorm.attributes, native.attributes);
  const table = /const uint sm4_unorm8\[256\]=uint\[256\]\(([^)]*)\);/.exec(unorm.vertex);
  assert.ok(table);
  const bits = new Uint32Array(Float32Array.from({length: 256}, (_, i) => i / 255).buffer);
  assert.deepEqual(
    table[1].split(',').map((b) => Number.parseInt(b, 16)),
    [...bits],
  );
  const c = (i) => `sm4_unorm8[int(sm4_a1.${i})]`;
  assert.equal(
    unorm.vertex.replace(table[0] + '\n', ''),
    native.vertex
      .replace('in highp vec4 sm4_a1;', 'in highp uvec4 sm4_a1;')
      .replace(
        'inputs[1]=floatBitsToUint(sm4_a1);',
        `inputs[1]=uvec4(${c('z')},${c('y')},${c('x')},${c('w')});`,
      ),
  );
});

test('SM4 executable creation rejects wrong stages, duplicate interface parts and signature/declaration disagreement', () => {
  const fixture = sm4SyntheticPipeline();
  assert.throws(() => parseSm4GlslShader(fixture.vertex, 'pixel'), /stage mismatch/);
  const mutatePart = (change) => {
    const bytes = fixture.vertex.slice();
    const container = parseDxbcContainer(bytes);
    change(container, bytes);
    assert.throws(() => parseSm4GlslShader(bytes, 'vertex'));
  };
  mutatePart((c) => {
    const p = c.parts.find((p) => p.kind === 'ISGN');
    new DataView(p.data.buffer, p.data.byteOffset).setUint32(8 + 16, 2, true);
  });
  mutatePart((c, b) =>
    b.set(new TextEncoder().encode('OSGN'), c.parts.find((p) => p.kind === 'ISGN').offset),
  );
  mutatePart((c) => {
    const p = c.parts.find((p) => p.kind === 'OSGN');
    p.data[8 + 20] = 3;
  });
});

/** Generated RDEF: resource order differs from buffer order and slots; variables share a register. */
function reflectedConstants() {
  const bytes = new Uint8Array(512),
    view = new DataView(bytes.buffer);
  const words = (at, values) =>
    values.forEach((value, i) => view.setUint32(at + i * 4, value, true));
  const names = {
    $Globals: 352,
    second: 361,
    sampler0: 368,
    image: 377,
    first: 383,
    scalar: 389,
    vector: 396,
    matrix: 403,
    compiler: 410,
  };
  for (const [name, at] of Object.entries(names))
    bytes.set(new TextEncoder().encode(name + '\0'), at);
  words(0, [2, 28, 4, 76, 0xfffe0400, 0x101, names.compiler]);
  words(28, [names.$Globals, 4, 204, 96, 0, 0]);
  words(52, [names.second, 0, 0, 16, 0, 0]);
  words(76, [names.sampler0, 3, 0, 0, 0, 15, 1, 0]);
  words(108, [names.second, 0, 0, 0, 0, 7, 1, 0]);
  words(140, [names.image, 2, 5, 4, 0xffffffff, 124, 1, 13]);
  words(172, [names.$Globals, 0, 0, 0, 0, 3, 1, 0]);
  words(204, [names.first, 0, 4, 2, 300, 448]);
  words(228, [names.scalar, 4, 4, 0, 300, 0]);
  words(252, [names.vector, 16, 16, 2, 316, 0]);
  words(276, [names.matrix, 32, 64, 2, 332, 0]);
  // six uint16 fields: class, float, rows, columns, array count, struct member count.
  words(300, [0x00030000, 0x00010001, 0, 0]);
  words(316, [0x00030001, 0x00040001, 0, 0]);
  words(332, [0x00030003, 0x00040004, 0, 0]);
  view.setUint32(448, 0x80000000, true); // Preserve negative zero as raw default bytes.
  return bytes;
}

test('RDEF resolves named constants by byte span and resource binding, preserving shared registers', async () => {
  const {parseSm4Reflection} = await import('../dist/graphics/d3d11-shader/reflection.js');
  const backing = new Uint8Array(525),
    bytes = backing.subarray(5, 517);
  bytes.set(reflectedConstants());
  const result = parseSm4Reflection(bytes);
  assert.equal(result.stage, 'vertex');
  assert.equal(result.creator, 'compiler');
  assert.equal(result.flags, 0x101);
  assert.deepEqual(
    result.buffers.map((b) => [b.name, b.slot, b.bytes]),
    [
      ['$Globals', 3, 96],
      ['second', 7, 16],
    ],
  );
  assert.deepEqual(
    result.buffers[0].variables.map((v) => [v.name, v.offset, v.bytes]),
    [
      ['first', 0, 4],
      ['scalar', 4, 4],
      ['vector', 16, 16],
      ['matrix', 32, 64],
    ],
  );
  assert.deepEqual(
    result.buffers[0].variables.map((v) => v.type),
    [
      {variableClass: 0, rows: 1, columns: 1},
      {variableClass: 0, rows: 1, columns: 1},
      {variableClass: 1, rows: 1, columns: 4},
      {variableClass: 3, rows: 4, columns: 4},
    ],
  );
  assert.deepEqual(
    result.resources.map((r) => [r.name, r.slot, r.inputType]),
    [
      ['sampler0', 15, 3],
      ['second', 7, 0],
      ['image', 124, 2],
      ['$Globals', 3, 0],
    ],
  );
  const value = result.buffers[0].variables[0].defaultValue;
  assert.equal(value.buffer, backing.buffer);
  assert.equal(value.byteOffset, 453);
  assert.deepEqual([...value], [0, 0, 0, 128]);
  assert.equal(result.buffers[0].variables[1].defaultValue, null);
  const pixel = reflectedConstants();
  new DataView(pixel.buffer).setUint32(16, 0xffff0400, true);
  assert.equal(parseSm4Reflection(pixel).stage, 'pixel');
  // An unbound reflected buffer has no fabricated slot.
  const unbound = reflectedConstants();
  new DataView(unbound.buffer).setUint32(8, 3, true);
  assert.equal(parseSm4Reflection(unbound).buffers[0].slot, null);
});

test('RDEF bounds counts, strings, defaults, variable spans and the supported type/profile subset', async () => {
  const {parseSm4Reflection} = await import('../dist/graphics/d3d11-shader/reflection.js');
  assert.throws(() => parseSm4Reflection(new Uint8Array(27)));
  const corrupt = (change) => {
    const bytes = reflectedConstants();
    change(new DataView(bytes.buffer), bytes);
    assert.throws(() => parseSm4Reflection(bytes));
  };
  for (const [at, value] of [
    [16, 0xffff0500],
    [0, 15],
    [4, 16],
    [8, 257],
    [12, 500],
    [24, 0],
    [24, 0xffffffff],
    [28, 0],
    [32, 4097],
    [36, 500],
    [40, 65552],
    [40, 15],
    [48, 2],
    [204, 0],
    [208, 96],
    [212, 0],
    [220, 0],
    [220, 500],
    [224, 510],
    [176, 4],
    [192, 14],
    [196, 0],
    [196, 2],
  ]) {
    corrupt((v) => v.setUint32(at, value, true));
  }
  corrupt((v, b) => {
    v.setUint32(24, 500, true);
    b.fill(1, 500);
  });
  corrupt((v) => v.setUint16(302, 2, true)); // int scalar unsupported.
  corrupt((v) => v.setUint16(304, 0, true));
  corrupt((v) => v.setUint16(308, 2, true)); // arrays unsupported.
  corrupt((v) => v.setUint16(310, 1, true)); // structs unsupported.
  corrupt((v) => v.setUint16(320, 2, true)); // a vector cannot have two rows.
  corrupt((v) => v.setUint32(228, 383, true)); // duplicate variable name.
  corrupt((v) => v.setUint32(52, 352, true)); // duplicate buffer name.
});
