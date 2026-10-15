import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {Opcode, RegisterType as R, parseD3D9Shader} from '../dist/graphics/d3d9-shader/bytecode.js';
import {disassembleD3D9Shader} from '../dist/graphics/d3d9-shader/disassemble.js';
import {findEmbeddedD3D9Shaders} from '../dist/graphics/d3d9-shader/scan.js';
import {
  TRANSLATED_OPCODES,
  glslFloat,
  translateD3D9ProgramToGlsl,
  translateD3D9ShaderToGlsl,
} from '../dist/graphics/d3d9-shader/glsl.js';

// ---- token builders ----

const X = 0,
  Y = 1,
  Z = 2,
  W = 3;
const swz = (a, b = a, c = b, d = c) => a | (b << 2) | (c << 4) | (d << 6);
const XYZW = swz(X, Y, Z, W);
const regBits = (type, index) => ((type & 7) << 28) | ((type & 0x18) << 8) | index;
const dst = (type, index, mask = 0xf, mods = 0) => [
  (0x80000000 | regBits(type, index) | (mask << 16) | (mods << 20)) >>> 0,
];
const src = (type, index, swizzle = XYZW, modifier = 0, relative) => {
  const head =
    (0x80000000 |
      regBits(type, index) |
      (swizzle << 16) |
      (modifier << 24) |
      (relative ? 0x2000 : 0)) >>>
    0;
  return relative
    ? [head, (0x80000000 | regBits(relative[0], 0) | (swz(relative[1]) << 16)) >>> 0]
    : [head];
};
const ins = (opcode, params = [], {control = 0, predicated = false} = {}) => [
  (opcode | (control << 16) | (params.length << 24) | (predicated ? 0x10000000 : 0)) >>> 0,
  ...params,
];
const dcl = (usage, usageIndex, destination, samplerType = 0) =>
  ins(Opcode.DCL, [
    (0x80000000 | usage | (usageIndex << 16) | (samplerType << 27)) >>> 0,
    ...destination,
  ]);
const f32 = (v) => new Uint32Array(new Float32Array([v]).buffer)[0];
const def = (index, values) => ins(Opcode.DEF, [...dst(R.CONST, index), ...values.map(f32)]);
const program = (version, ...body) => {
  const words = [version, ...body.flat(), 0x0000ffff];
  return new Uint8Array(new Uint32Array(words).buffer);
};
const VS2 = 0xfffe0200,
  VS3 = 0xfffe0300,
  PS2 = 0xffff0200,
  PS3 = 0xffff0300;

/** CTAB comment: constants [{name, set, index, count, cls, type, rows, cols}]. */
function ctab(constants, target = 'vs_3_0') {
  const bytes = [];
  const u32 = (v) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const u16 = (v) => bytes.push(v & 0xff, (v >>> 8) & 0xff);
  const headerSize = 28,
    infoOffset = headerSize,
    typeOffset = infoOffset + constants.length * 20,
    stringOffset = typeOffset + constants.length * 16;
  const strings = [];
  let stringCursor = stringOffset;
  const addString = (s) => {
    const at = stringCursor;
    strings.push(...Buffer.from(s + '\0', 'latin1'));
    stringCursor += s.length + 1;
    return at;
  };
  const creator = addString('test compiler'),
    targetAt = addString(target);
  const names = constants.map((c) => addString(c.name));
  u32(headerSize);
  u32(creator);
  u32(0);
  u32(constants.length);
  u32(infoOffset);
  u32(0);
  u32(targetAt);
  constants.forEach((c, i) => {
    u32(names[i]);
    u16(c.set);
    u16(c.index);
    u16(c.count);
    u16(0);
    u32(typeOffset + i * 16);
    u32(0);
  });
  for (const c of constants) {
    u16(c.cls);
    u16(c.type);
    u16(c.rows);
    u16(c.cols);
    u16(1);
    u16(0);
    u32(0);
  }
  bytes.push(...strings);
  while (bytes.length % 4) bytes.push(0);
  const words = [0x42415443, ...new Uint32Array(new Uint8Array(bytes).buffer)];
  return [((words.length << 16) | 0xfffe) >>> 0, ...words];
}

// ---- shaders ----

const vertexShader = program(
  VS3,
  ctab([
    {name: 'cMat', set: 2, index: 0, count: 4, cls: 3, type: 3, rows: 4, cols: 4},
    {name: 'cBones', set: 2, index: 8, count: 16, cls: 1, type: 3, rows: 1, cols: 4},
    {name: 'cHeight', set: 3, index: 0, count: 1, cls: 4, type: 12, rows: 1, cols: 1},
  ]),
  def(4, [1, 0, 0.5, -0.5]),
  ins(Opcode.DEFI, [...dst(R.CONSTINT, 0), 3, 0, 1, 0]),
  dcl(0, 0, dst(R.INPUT, 0)),
  dcl(5, 1, dst(R.INPUT, 1)),
  dcl(0, 0, dst(R.TEXCRDOUT_OUTPUT, 0)),
  dcl(5, 0, dst(R.TEXCRDOUT_OUTPUT, 1, 0x3)),
  dcl(10, 0, dst(R.TEXCRDOUT_OUTPUT, 2)),
  dcl(4, 0, dst(R.TEXCRDOUT_OUTPUT, 3, 0x1)),
  dcl(0, 0, dst(R.SAMPLER, 0), 2),
  ins(Opcode.M4x4, [...dst(R.TEMP, 0), ...src(R.INPUT, 0), ...src(R.CONST, 0)]),
  ins(Opcode.MOVA, [...dst(R.ADDR_TEXTURE, 0, 0x1), ...src(R.INPUT, 1, swz(Z))]),
  ins(Opcode.ADD, [
    ...dst(R.TEMP, 1),
    ...src(R.CONST, 8, XYZW, 0, [R.ADDR_TEXTURE, X]),
    ...src(R.CONST, 4, swz(X, Y, Z, Z), 1),
  ]),
  ins(Opcode.LOOP, [...src(R.LOOP, 0), ...src(R.CONSTINT, 0)]),
  ins(Opcode.ADD, [...dst(R.TEMP, 1), ...src(R.TEMP, 1), ...src(R.CONST, 8, XYZW, 0, [R.LOOP, X])]),
  ins(Opcode.ENDLOOP),
  ins(Opcode.REP, [...src(R.CONSTINT, 0)]),
  ins(Opcode.IFC, [...src(R.TEMP, 1, swz(X)), ...src(R.CONST, 4, swz(Y))], {control: 4}),
  ins(Opcode.BREAK),
  ins(Opcode.ELSE),
  ins(Opcode.RCP, [...dst(R.TEMP, 2, 0x1), ...src(R.TEMP, 1, swz(W))]),
  ins(Opcode.ENDIF),
  ins(Opcode.ENDREP),
  ins(Opcode.SETP, [...dst(R.PREDICATE, 0, 0x3), ...src(R.TEMP, 1), ...src(R.CONST, 4)], {
    control: 1,
  }),
  ins(
    Opcode.MOV,
    [...dst(R.TEMP, 0, 0x3), ...src(R.PREDICATE, 0, swz(Y, X), 13), ...src(R.TEMP, 1)],
    {predicated: true},
  ),
  ins(Opcode.SINCOS, [...dst(R.TEMP, 3, 0x3), ...src(R.TEMP, 1, swz(X))]),
  ins(Opcode.TEXLDL, [...dst(R.TEMP, 4), ...src(R.INPUT, 1), ...src(R.SAMPLER, 0)]),
  ins(Opcode.CALL, [...src(R.LABEL, 2)]),
  ins(Opcode.MOV, [...dst(R.TEXCRDOUT_OUTPUT, 0), ...src(R.TEMP, 0)]),
  ins(Opcode.MOV, [...dst(R.TEXCRDOUT_OUTPUT, 1, 0x3), ...src(R.INPUT, 1)]),
  ins(Opcode.MOV, [...dst(R.TEXCRDOUT_OUTPUT, 2, 0xf, 1), ...src(R.TEMP, 3)]),
  ins(Opcode.MOV, [...dst(R.TEXCRDOUT_OUTPUT, 3, 0x1), ...src(R.TEMP, 4, swz(X))]),
  ins(Opcode.RET),
  ins(Opcode.LABEL, [...src(R.LABEL, 2)]),
  ins(Opcode.NRM, [...dst(R.TEMP, 3), ...src(R.TEMP, 3, XYZW, 11)]),
  ins(Opcode.RET),
);

const pixel2 = program(
  PS2,
  def(0, [-2, 1, 0.25, 0]),
  dcl(0, 0, dst(R.ADDR_TEXTURE, 0, 0x3)),
  dcl(0, 0, dst(R.INPUT, 0)),
  dcl(0, 0, dst(R.SAMPLER, 0), 2),
  dcl(0, 0, dst(R.SAMPLER, 1), 3),
  ins(Opcode.TEX, [...dst(R.TEMP, 0, 0xf, 2), ...src(R.ADDR_TEXTURE, 0), ...src(R.SAMPLER, 0)]),
  ins(Opcode.TEX, [...dst(R.TEMP, 1), ...src(R.ADDR_TEXTURE, 0), ...src(R.SAMPLER, 0)], {
    control: 1,
  }),
  ins(Opcode.TEX, [...dst(R.TEMP, 2), ...src(R.TEMP, 0), ...src(R.SAMPLER, 1, swz(W, Z, Y, X))], {
    control: 2,
  }),
  ins(Opcode.TEXKILL, [...dst(R.TEMP, 0, 0x7)]),
  ins(Opcode.CMP, [
    ...dst(R.TEMP, 3),
    ...src(R.TEMP, 0, XYZW, 1),
    ...src(R.TEMP, 1),
    ...src(R.TEMP, 2),
  ]),
  ins(Opcode.DP2ADD, [
    ...dst(R.TEMP, 3, 0x8, 1),
    ...src(R.TEMP, 0),
    ...src(R.CONST, 0),
    ...src(R.CONST, 0, swz(Z)),
  ]),
  ins(Opcode.MAD, [
    ...dst(R.TEMP, 3, 0x7),
    ...src(R.INPUT, 0),
    ...src(R.CONST, 0, swz(X)),
    ...src(R.CONST, 0, swz(Y)),
  ]),
  ins(Opcode.POW, [
    ...dst(R.TEMP, 4, 0x1),
    ...src(R.TEMP, 3, swz(X), 11),
    ...src(R.CONST, 1, swz(X)),
  ]),
  ins(Opcode.LRP, [
    ...dst(R.TEMP, 3, 0x7),
    ...src(R.TEMP, 4, swz(X)),
    ...src(R.TEMP, 3),
    ...src(R.INPUT, 0),
  ]),
  ins(Opcode.MOV, [...dst(R.COLOROUT, 0), ...src(R.TEMP, 3)]),
);

const pixel3 = program(
  PS3,
  ins(Opcode.DEFB, [...dst(R.CONSTBOOL, 1), 1]),
  dcl(5, 0, dst(R.INPUT, 0, 0x3, 4)),
  dcl(5, 1, dst(R.INPUT, 1, 0x3)),
  dcl(0, 0, dst(R.MISCTYPE, 0, 0x3)),
  dcl(0, 0, dst(R.MISCTYPE, 1, 0x1)),
  dcl(0, 0, dst(R.SAMPLER, 0), 4),
  ins(Opcode.DSX, [...dst(R.TEMP, 0), ...src(R.INPUT, 0)]),
  ins(Opcode.DSY, [...dst(R.TEMP, 1), ...src(R.INPUT, 0)]),
  ins(Opcode.TEXLDD, [
    ...dst(R.TEMP, 2),
    ...src(R.INPUT, 0),
    ...src(R.SAMPLER, 0),
    ...src(R.TEMP, 0),
    ...src(R.TEMP, 1),
  ]),
  ins(Opcode.IF, [...src(R.CONSTBOOL, 0)]),
  ins(Opcode.MUL, [...dst(R.TEMP, 2), ...src(R.TEMP, 2), ...src(R.MISCTYPE, 1, swz(X))]),
  ins(Opcode.ENDIF),
  ins(Opcode.IF, [...src(R.CONSTBOOL, 1)]),
  ins(Opcode.ADD, [...dst(R.TEMP, 2, 0x3), ...src(R.TEMP, 2), ...src(R.MISCTYPE, 0)]),
  ins(Opcode.ENDIF),
  ins(Opcode.LOG, [...dst(R.TEMP, 3, 0x1), ...src(R.TEMP, 2, swz(Y))]),
  ins(Opcode.RSQ, [...dst(R.TEMP, 3, 0x2), ...src(R.TEMP, 2, swz(Z))]),
  ins(Opcode.FRC, [...dst(R.TEMP, 3, 0xc), ...src(R.INPUT, 1)]),
  ins(Opcode.MOV, [...dst(R.COLOROUT, 0), ...src(R.TEMP, 2)]),
  ins(Opcode.MOV, [...dst(R.COLOROUT, 1), ...src(R.TEMP, 3)]),
  ins(Opcode.MOV, [...dst(R.DEPTHOUT, 0, 0x1), ...src(R.TEMP, 3, swz(X))]),
);

// ---- parsing and disassembly ----

test('parses SM3 vertex tokens: dcl, def, relative addressing, predication, CTAB', () => {
  const shader = parseD3D9Shader(vertexShader);
  assert.deepEqual(shader.version, {stage: 'vertex', major: 3, minor: 0});
  assert.equal(shader.byteLength, vertexShader.byteLength);
  const table = shader.constantTable;
  assert.equal(table.creator, 'test compiler');
  assert.equal(table.target, 'vs_3_0');
  assert.deepEqual(
    table.constants.map((c) => [c.name, c.registerSet, c.registerIndex, c.registerCount]),
    [
      ['cMat', 2, 0, 4],
      ['cBones', 2, 8, 16],
      ['cHeight', 3, 0, 1],
    ],
  );
  const add = shader.instructions.find((i) => i.opcode === Opcode.ADD);
  assert.deepEqual(add.sources[0].relative, {type: R.ADDR_TEXTURE, index: 0, component: 0});
  assert.equal(add.sources[1].modifier, 1);
  const predicated = shader.instructions.find((i) => i.predicate);
  assert.equal(predicated.predicate.type, R.PREDICATE);
  assert.equal(predicated.predicate.modifier, 13);
  assert.deepEqual(
    shader.instructions.find((i) => i.opcode === Opcode.DEFI).intValues,
    [3, 0, 1, 0],
  );
});

test('disassembles with fxc mnemonics', () => {
  const text = disassembleD3D9Shader(parseD3D9Shader(vertexShader));
  for (const line of [
    '//   column_major float4x4 cMat;',
    '//   cBones  c8      16',
    '    vs_3_0',
    '    def c4, 1, 0, 0.5, -0.5',
    '    defi i0, 3, 0, 1, 0',
    '    dcl_position v0',
    '    dcl_texcoord1 v1',
    '    dcl_texcoord o1.xy',
    '    dcl_psize o3.x',
    '    dcl_2d s0',
    '    m4x4 r0, v0, c0',
    '    mova a0.x, v1.z',
    '    add r1, c8[a0.x], -c4.xyz',
    '    loop aL, i0',
    '      add r1, r1, c8[aL]',
    '    endloop',
    '      if_lt r1.x, c4.y',
    '      else',
    '        rcp r2.x, r1.w',
    '    setp_gt p0.xy, r1, c4',
    '    (!p0.yx) mov r0.xy, r1',
    '    sincos r3.xy, r1.x',
    '    texldl r4, v1, s0',
    '    call l2',
    '    mov_sat o2, r3',
    '    label l2',
    '    nrm r3, r3_abs',
  ])
    assert.ok(text.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${text}`);

  const ps2 = disassembleD3D9Shader(parseD3D9Shader(pixel2));
  for (const line of [
    '    ps_2_0',
    '    dcl t0.xy',
    '    dcl v0',
    '    dcl_cube s1',
    '    texld_pp r0, t0, s0',
    '    texldp r1, t0, s0',
    '    texldb r2, r0, s1.wzyx',
    '    texkill r0.xyz',
    '    cmp r3, -r0, r1, r2',
    '    dp2add_sat r3.w, r0, c0, c0.z',
    '    pow r4.x, r3_abs.x, c1.x',
  ])
    assert.ok(ps2.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${ps2}`);

  const ps3 = disassembleD3D9Shader(parseD3D9Shader(pixel3));
  for (const line of [
    '    defb b1, true',
    '    dcl_texcoord_centroid v0.xy',
    '    dcl vPos.xy',
    '    dcl vFace.x',
    '    dcl_volume s0',
    '    texldd r2, v0, s0, r0, r1',
    '    mul r2, r2, vFace.x',
    '    mov oDepth.x, r3.x',
  ])
    assert.ok(ps3.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${ps3}`);
});

test('rejects malformed and unsupported token streams', () => {
  assert.throws(() => parseD3D9Shader(program(0xffff0101, ins(Opcode.NOP))), /Unsupported/);
  assert.throws(
    () =>
      parseD3D9Shader(
        new Uint8Array(new Uint32Array([PS3, ins(Opcode.MOV)[0] | (2 << 24)]).buffer),
      ),
    /Truncated/,
  );
  // A length field that disagrees with the parameter tokens.
  const bad = program(PS3, [
    (Opcode.DCL | (3 << 24)) >>> 0,
    0x80000000,
    ...dst(R.INPUT, 0),
    0x80000000,
  ]);
  assert.throws(() => parseD3D9Shader(bad), /Invalid D3D9 destination|length mismatch/);
  assert.throws(() => parseD3D9Shader(program(PS3, ins(200))), /Unknown D3D9 opcode/);
  // ps_2_0 has no relative addressing.
  assert.throws(
    () =>
      parseD3D9Shader(
        program(
          PS2,
          ins(Opcode.MOV, [...dst(R.TEMP, 0), ...src(R.CONST, 0, XYZW, 0, [R.ADDR_TEXTURE, X])]),
        ),
      ),
    /Relative addressing/,
  );
});

test('finds embedded token streams at any offset and skips false version tokens', () => {
  const blob = pixel2;
  const data = new Uint8Array(3 + 8 + blob.byteLength + 5);
  data.set([0x00, 0x02, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00], 3); // version token without an end
  data.set(blob, 11);
  const found = findEmbeddedD3D9Shaders(data);
  assert.equal(found.length, 1);
  assert.equal(found[0].offset, 11);
  assert.equal(found[0].bytes.byteLength, blob.byteLength);
});

// ---- translation ----

test('vertex translation: clip-space fixup, mova rounding, loops, predicates, subroutines', () => {
  const glsl = translateD3D9ShaderToGlsl(parseD3D9Shader(vertexShader));
  const s = glsl.source;
  assert.ok(s.startsWith('#version 300 es\n'));
  for (const line of [
    'uniform vec4 vs_c[24];',
    'uniform sampler2D vs_s0;',
    'const vec4 dx_def_c4 = vec4(1.0, 0.0, 0.5, -0.5);',
    'const ivec4 dx_def_i0 = ivec4(3, 0, 1, 0);',
    'in vec4 a_position0;',
    'in vec4 a_texcoord1;',
    'out vec4 v_texcoord0;',
    'out vec4 v_color0;',
    'uniform vec4 dx_posFixup;',
    '  r0 = vec4(dot(a_position0, vs_c[0]), dot(a_position0, vs_c[1]), dot(a_position0, vs_c[2]), dot(a_position0, vs_c[3]));',
    '  dx_a0.x = int(floor((a_texcoord1.zzzz).x + 0.5));',
    '  r1 = (dx_c[8 + dx_a0.x] + (-dx_def_c4.xyzz));',
    '  dx_c[4] = dx_def_c4;',
    '  for (int dx_loop0 = 0; dx_loop0 < dx_def_i0.x; ++dx_loop0, dx_aL += dx_def_i0.z) {',
    '    r1 = (r1 + dx_c[8 + dx_aL]);',
    '  dx_aL = dx_aLsave0;',
    '  for (int dx_rep1 = 0; dx_rep1 < dx_def_i0.x; ++dx_rep1) {',
    '    if (r1.x < dx_def_c4.y) {',
    '      r2.x = dx_rcp(r1.w);',
    '  dx_p0.xy = greaterThan(r1, dx_def_c4).xy;',
    '  r0.xy = mix(r0.xy, (r1).xy, not(dx_p0.yx));',
    '  r3.xy = (vec4(cos(r1.x), sin(r1.x), 0.0, 0.0)).xy;',
    '  r4 = textureLod(vs_s0, a_texcoord1.xy, a_texcoord1.w);',
    '  dx_label2();',
    '  o2 = clamp(r3, 0.0, 1.0);',
    'void dx_label2();',
    '  r3 = dx_nrm(abs(r3));',
    '  gl_Position = vec4(o0.x * dx_posFixup.x + dx_posFixup.z * o0.w, o0.y * dx_posFixup.y + dx_posFixup.w * o0.w, o0.z * 2.0 - o0.w, o0.w);',
    '  gl_PointSize = o3.x;',
    '  v_texcoord0 = o1;',
  ])
    assert.ok(s.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${s}`);
  assert.deepEqual(
    glsl.attributes.map((a) => [a.name, a.register]),
    [
      ['a_position0', 0],
      ['a_texcoord1', 1],
    ],
  );
  assert.deepEqual(
    glsl.outputs.map((o) => o.name),
    ['v_texcoord0', 'v_color0'],
  );
  assert.ok(glsl.writesPointSize);
  assert.deepEqual(
    glsl.constants.map((c) => [c.name, c.uniform]),
    [
      ['cMat', 'vs_c'],
      ['cBones', 'vs_c'],
      ['cHeight', 'vs_s0'],
    ],
  );
  // Translation is a pure function of the bytecode.
  assert.equal(translateD3D9ShaderToGlsl(parseD3D9Shader(vertexShader.slice())).source, s);
});

test('ps_2_0 translation: texld variants, texkill, cmp, dp2add, special-case helpers', () => {
  const glsl = translateD3D9ShaderToGlsl(parseD3D9Shader(pixel2));
  const s = glsl.source;
  for (const line of [
    'uniform vec4 ps_c[2];',
    'uniform sampler2D ps_s0;',
    'uniform samplerCube ps_s1;',
    'in vec4 v_texcoord0;',
    'in vec4 v_color0;',
    'layout(location = 0) out vec4 dx_oC0;',
    '  r0 = texture(ps_s0, t0.xy);',
    '  r1 = textureProj(ps_s0, t0.xyw);',
    '  r2 = texture(ps_s1, r0.xyz, r0.w).wzyx;',
    '  if (any(lessThan(r0.xyz, vec3(0.0)))) discard;',
    '  r3 = mix(r2, r1, greaterThanEqual((-r0), vec4(0.0)));',
    '  r3.w = clamp((dot(r0.xy, dx_def_c0.xy) + dx_def_c0.z), 0.0, 1.0);',
    '  r4.x = dx_pow(abs(r3.x), ps_c[1].x);',
    '  r3.xyz = (mix(v0, r3, r4.xxxx)).xyz;',
    'float dx_inf() { return uintBitsToFloat(0x7f800000u); }',
    '  t0 = v_texcoord0;',
    '  dx_oC0 = oC0;',
  ])
    assert.ok(s.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${s}`);
  assert.deepEqual(
    glsl.samplers.map((x) => [x.name, x.dimension]),
    [
      ['ps_s0', '2d'],
      ['ps_s1', 'cube'],
    ],
  );
});

test('ps_3_0 translation: vPos, vFace, centroid, derivatives, depth and MRT outputs', () => {
  const glsl = translateD3D9ShaderToGlsl(parseD3D9Shader(pixel3));
  const s = glsl.source;
  for (const line of [
    'precision highp sampler3D;',
    'uniform bool ps_b[1];',
    'const bool dx_def_b1 = true;',
    'centroid in vec4 v_texcoord0;',
    'uniform sampler3D ps_s0;',
    '  r1 = (dFdy(v0) * dx_screenFixup.y);',
    '  r2 = textureGrad(ps_s0, v0.xyz, r0.xyz, r1.xyz);',
    '  if (ps_b[0]) {',
    '  if (dx_def_b1) {',
    '    r2 = (r2 * dx_vFace.xxxx);',
    '  r3.x = dx_log(r2.y);',
    '  r3.y = dx_rsq(r2.z);',
    '  dx_vPos = vec4(gl_FragCoord.xy * dx_screenFixup.xy + dx_screenFixup.zw, 0.0, 0.0);',
    '  dx_vFace = vec4(gl_FrontFacing ? 1.0 : -1.0);',
    'layout(location = 1) out vec4 dx_oC1;',
    '  gl_FragDepth = oDepth.x;',
  ])
    assert.ok(s.includes(line + '\n'), `missing ${JSON.stringify(line)} in\n${s}`);
  assert.deepEqual(glsl.colorOutputs, [0, 1]);
  assert.ok(glsl.writesDepth);
  assert.deepEqual(
    glsl.inputs.map((i) => [i.name, i.centroid]),
    [
      ['v_texcoord0', true],
      ['v_texcoord1', false],
    ],
  );
});

test('program translation links varyings and propagates centroid', () => {
  const vs = parseD3D9Shader(vertexShader),
    ps = parseD3D9Shader(pixel3);
  const {vertex, fragment} = translateD3D9ProgramToGlsl(vs, ps);
  assert.ok(vertex.source.includes('centroid out vec4 v_texcoord0;\n'));
  // The vertex shader writes texcoord0 and color0 but not texcoord1.
  const texcoord1 = fragment.inputs.find((i) => i.name === 'v_texcoord1');
  assert.equal(texcoord1.linked, false);
  assert.ok(!fragment.source.includes('in vec4 v_texcoord1;'));
});

test('float literals are exact for float32', () => {
  assert.equal(glslFloat(1), '1.0');
  assert.equal(glslFloat(Math.fround(Math.PI)), '3.1415927');
  assert.equal(glslFloat(-0), '-0.0');
  assert.equal(glslFloat(Math.fround(1e-10)), '1e-10');
  assert.equal(glslFloat(Infinity), 'uintBitsToFloat(0x7f800000u)');
});

test('synthetic shaders exercise most translated opcodes', () => {
  const used = new Set();
  for (const bytes of [vertexShader, pixel2, pixel3])
    for (const op of translateD3D9ShaderToGlsl(parseD3D9Shader(bytes)).opcodes) used.add(op);
  for (const op of used) assert.ok(TRANSLATED_OPCODES.has(op));
  assert.ok(used.size >= 30, `only ${used.size} opcodes exercised`);
});

// Local-only: the compiled shaders shipped with NEKOPARA's Kirikiri Z plugins.
const localDlls = [
  'targetgame/nekopara_vol1/emotedriver.dll',
  'targetgame/nekopara_vol1/plugin/drawdeviceD3DZ.dll',
].filter((path) => existsSync(path));
test('local plugin shaders parse and translate', {skip: localDlls.length === 0}, () => {
  let count = 0;
  for (const path of localDlls)
    for (const blob of findEmbeddedD3D9Shaders(new Uint8Array(readFileSync(path)))) {
      translateD3D9ShaderToGlsl(blob.shader);
      count++;
    }
  assert.ok(count > 0);
});
