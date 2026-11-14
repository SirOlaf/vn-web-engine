import type {BlendState} from './blend.js';
import type {DrawCommand} from './draw-list.js';
import type {GpuRenderSurface} from './gpu-render-surface.js';
import type {TriangleImage} from './triangle-draw.js';

/**
 * D3D11 texel formats whose bytes are uploaded unchanged and decoded on the GPU. Decoding
 * yields the sampled RGBA of the D3D format: `r8` is (r,0,0,1), `a8` (0,0,0,a), `r8g8`
 * (r,g,0,1); `b8g8r8a8` swaps the stored B and R bytes. `bc1`..`bc3` are DXT1/3/5, `bc7`
 * BPTC; BC1 and BC3 interpolate with truncating integer division, and a reserved BC7
 * block (no mode bit) decodes to zero in every channel.
 */
export type GpuTextureFormat = 'bc1' | 'bc2' | 'bc3' | 'bc7' | 'r8' | 'a8' | 'r8g8' | 'b8g8r8a8';

const blockBytes = (format: GpuTextureFormat): number => (format === 'bc1' ? 8 : 16);
const isBlock = (format: GpuTextureFormat): boolean => format.startsWith('bc');
const texelBytes = (format: 'r8' | 'a8' | 'r8g8' | 'b8g8r8a8'): number =>
  format === 'b8g8r8a8' ? 4 : format === 'r8g8' ? 2 : 1;

/** Byte length of a `width`×`height` level: whole 4×4 blocks, or tightly packed rows. */
export function gpuTextureByteLength(
  format: GpuTextureFormat,
  width: number,
  height: number,
): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw Error('Invalid texture dimensions');
  return isBlock(format)
    ? Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes(format)
    : width * height * texelBytes(format as 'r8');
}

/**
 * The upload of a level's bytes as an RGBA8 image, four bytes per texel: each row holds one
 * row of blocks or one row of texels, padded to whole texels. Exactly fitting data is
 * uploaded without a copy.
 */
export function packedGpuTexture(
  format: GpuTextureFormat,
  width: number,
  height: number,
  bytes: Uint8Array,
): TriangleImage {
  const length = gpuTextureByteLength(format, width, height);
  if (bytes.length < length) throw Error('Texture data is truncated');
  const rowBytes = isBlock(format)
      ? Math.ceil(width / 4) * blockBytes(format)
      : width * texelBytes(format as 'r8'),
    rows = isBlock(format) ? Math.ceil(height / 4) : height,
    texels = Math.ceil(rowBytes / 4);
  if (texels * 4 === rowBytes)
    return {width: texels, height: rows, pixels: bytes.subarray(0, length)};
  const pixels = new Uint8Array(texels * 4 * rows);
  for (let y = 0; y < rows; y++)
    pixels.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), y * texels * 4);
  return {width: texels, height: rows, pixels};
}

// BC7 tables (BPTC): two-subset partitions as one bit per texel, three-subset partitions as
// two bits per texel, and the anchor (fix-up) texels of the second and third subsets.
const P2 = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800,
  0xffe8, 0xff00, 0xfff0, 0xf000, 0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce,
  0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c, 0xaaaa, 0xf0f0, 0x5a5a, 0x33cc,
  0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718,
  0xccf0, 0x0fcc, 0x7744, 0xee22,
];
const P3 = [
  0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050,
  0xaa550000, 0xaa555500, 0xaaaa5500, 0x90909090, 0x94949494, 0xa4a4a4a4, 0xa9a59450, 0x2a0a4250,
  0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0, 0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500,
  0x0050a4a4, 0xaaa59090, 0x14696914, 0x69691400, 0xa08585a0, 0xaa821414, 0x50a4a450, 0x6a5a0200,
  0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224, 0x50a50a50,
  0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600,
  0xaa444444, 0x54a854a8, 0x95809580, 0x96969600, 0xa85454a8, 0x80959580, 0xaa141414, 0x96960000,
  0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000, 0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254,
];
const A2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2,
  2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15,
  15, 15, 15, 15, 2, 2, 15,
];
const A3A = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5,
  15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10,
  8, 13, 15, 12, 3, 3,
];
const A3B = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6,
  10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15,
  15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];
const WEIGHTS: Record<number, readonly number[]> = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
};
/** Per mode: subsets, partition, rotation and index-selection bits, colour and alpha bits,
 * endpoint and shared p-bits, primary and secondary index bits. */
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
] as const satisfies readonly (readonly number[])[];

function decodeBc7Block(b: Uint8Array, o: number, out: Uint8Array, stride: number): void {
  let pos = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v |= ((b[o + (pos >> 3)]! >> (pos & 7)) & 1) << i;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !((b[o]! >> mode) & 1)) mode++;
  if (mode === 8) {
    for (let y = 0; y < 4; y++) out.fill(0, y * stride, y * stride + 16);
    return;
  }
  pos = mode + 1;
  const [ns, pb, rb, isbBits, cb, ab, epb, spb, ib, ib2] = MODES[mode]!;
  const part = take(pb),
    rot = take(rb),
    isb = take(isbBits);
  const e = Array.from({length: 2 * ns}, () => [0, 0, 0, 255]);
  for (let c = 0; c < 3; c++) for (const x of e) x[c] = take(cb);
  if (ab) for (const x of e) x[3] = take(ab);
  const bits = [cb, cb, cb, ab];
  if (epb)
    for (const x of e) {
      const p = take(1);
      for (let c = 0; c < 4; c++) if (bits[c]) x[c] = (x[c]! << 1) | p;
    }
  if (spb) {
    const ps = Array.from({length: ns}, () => take(1));
    e.forEach((x, i) => {
      for (let c = 0; c < 4; c++) if (bits[c]) x[c] = (x[c]! << 1) | ps[i >> 1]!;
    });
  }
  for (const x of e)
    for (let c = 0; c < 4; c++) {
      if (!bits[c]) continue;
      const n = bits[c]! + (epb || spb ? 1 : 0),
        v = x[c]! << (8 - n);
      x[c] = v | (v >> n);
    }
  const subset = (t: number) =>
    ns === 1 ? 0 : ns === 2 ? (P2[part]! >> t) & 1 : (P3[part]! >>> (2 * t)) & 3;
  const anchor = (t: number) =>
    t === 0 || (ns === 2 && t === A2[part]) || (ns === 3 && (t === A3A[part] || t === A3B[part]));
  const i1 = Array.from({length: 16}, (_, t) => take(anchor(t) ? ib - 1 : ib));
  const i2 = ib2 ? Array.from({length: 16}, (_, t) => take(t === 0 ? ib2 - 1 : ib2)) : null;
  for (let t = 0; t < 16; t++) {
    const s = subset(t),
      e0 = e[2 * s]!,
      e1 = e[2 * s + 1]!;
    let ci = i1[t]!,
      cbits: number = ib,
      ai = i1[t]!,
      abits: number = ib;
    if (i2) {
      if (isb) [ci, cbits, ai, abits] = [i2[t]!, ib2, i1[t]!, ib];
      else [ai, abits] = [i2[t]!, ib2];
    }
    const wc = WEIGHTS[cbits]![ci]!,
      wa = WEIGHTS[abits]![ai]!;
    const px = [0, 1, 2].map((c) => ((64 - wc) * e0[c]! + wc * e1[c]! + 32) >> 6);
    px.push(((64 - wa) * e0[3]! + wa * e1[3]! + 32) >> 6);
    if (rot) [px[rot - 1], px[3]] = [px[3]!, px[rot - 1]!];
    out.set(px, (t >> 2) * stride + (t & 3) * 4);
  }
}

function bc1Palette(b: Uint8Array, o: number, four: boolean): number[][] {
  const c0 = b[o]! | (b[o + 1]! << 8),
    c1 = b[o + 2]! | (b[o + 3]! << 8);
  const rgb = (c: number) => {
    const r = (c >> 11) & 31,
      g = (c >> 5) & 63,
      bl = c & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (bl << 3) | (bl >> 2)];
  };
  const p0 = rgb(c0),
    p1 = rgb(c1);
  return c0 > c1 || four
    ? [
        [...p0, 255],
        [...p1, 255],
        [...p0.map((v, i) => Math.floor((2 * v + p1[i]!) / 3)), 255],
        [...p0.map((v, i) => Math.floor((v + 2 * p1[i]!) / 3)), 255],
      ]
    : [
        [...p0, 255],
        [...p1, 255],
        [...p0.map((v, i) => (v + p1[i]!) >> 1), 255],
        [0, 0, 0, 0],
      ];
}

function decodeBcBlock(
  format: 'bc1' | 'bc2' | 'bc3',
  b: Uint8Array,
  o: number,
  out: Uint8Array,
  stride: number,
): void {
  const c = format === 'bc1' ? o : o + 8,
    palette = bc1Palette(b, c, format !== 'bc1');
  const alpha: number[] = [];
  if (format === 'bc3') {
    const a0 = b[o]!,
      a1 = b[o + 1]!;
    alpha.push(a0, a1);
    if (a0 > a1) for (let i = 1; i < 7; i++) alpha.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
    else {
      for (let i = 1; i < 5; i++) alpha.push(Math.floor(((5 - i) * a0 + i * a1) / 5));
      alpha.push(0, 255);
    }
  }
  for (let t = 0; t < 16; t++) {
    const index = (b[c + 4 + (t >> 2)]! >> ((t & 3) * 2)) & 3,
      px = [...palette[index]!];
    if (format === 'bc2') px[3] = ((b[o + (t >> 1)]! >> ((t & 1) * 4)) & 15) * 17;
    else if (format === 'bc3') {
      const bit = 16 + t * 3;
      let v = 0;
      for (let i = 0; i < 3; i++) v |= ((b[o + ((bit + i) >> 3)]! >> ((bit + i) & 7)) & 1) << i;
      px[3] = alpha[v]!;
    }
    out.set(px, (t >> 2) * stride + (t & 3) * 4);
  }
}

/**
 * CPU reference of the GPU decode: RGBA rows, top row first. Blocks beyond the level's
 * edge are decoded and cropped.
 */
export function decodeGpuTexture(
  format: GpuTextureFormat,
  width: number,
  height: number,
  bytes: Uint8Array,
): Uint8Array {
  const length = gpuTextureByteLength(format, width, height);
  if (bytes.length < length) throw Error('Texture data is truncated');
  const out = new Uint8Array(width * height * 4);
  if (!isBlock(format)) {
    const n = texelBytes(format as 'r8');
    for (let i = 0; i < width * height; i++) {
      const s = bytes.subarray(i * n, i * n + n),
        o = i * 4;
      if (format === 'r8') out.set([s[0]!, 0, 0, 255], o);
      else if (format === 'a8') out.set([0, 0, 0, s[0]!], o);
      else if (format === 'r8g8') out.set([s[0]!, s[1]!, 0, 255], o);
      else out.set([s[2]!, s[1]!, s[0]!, s[3]!], o);
    }
    return out;
  }
  const bw = Math.ceil(width / 4),
    bh = Math.ceil(height / 4),
    size = blockBytes(format),
    block = new Uint8Array(64);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * size;
      if (format === 'bc7') decodeBc7Block(bytes, o, block, 16);
      else decodeBcBlock(format as 'bc1', bytes, o, block, 16);
      for (let y = 0; y < 4 && by * 4 + y < height; y++) {
        const columns = Math.min(4, width - bx * 4);
        out.set(block.subarray(y * 16, y * 16 + columns * 4), ((by * 4 + y) * width + bx * 4) * 4);
      }
    }
  return out;
}

const glslArray = (type: string, name: string, values: readonly number[]) =>
  `const ${type} ${name}[${values.length}]=${type}[${values.length}](${values
    .map((v) => (type === 'uint' ? `${v >>> 0}u` : `${v}`))
    .join(',')});`;

const FETCH = `uint byteAt(int row,int index){uvec4 t=uvec4(round(texelFetch(atlas,ivec2(index>>2,row),0)*255.));int c=index&3;return c==0?t.x:c==1?t.y:c==2?t.z:t.w;}
uint wordAt(int row,int texel){uvec4 t=uvec4(round(texelFetch(atlas,ivec2(texel,row),0)*255.));return t.x|(t.y<<8)|(t.z<<16)|(t.w<<24);}
uvec4 blockAt(int row,int texel){return uvec4(wordAt(row,texel),wordAt(row,texel+1),wordAt(row,texel+2),wordAt(row,texel+3));}`;

const BC7 = `${glslArray('uint', 'P2', P2)}${glslArray('uint', 'P3', P3)}${glslArray('int', 'A2', A2)}${glslArray('int', 'A3A', A3A)}${glslArray('int', 'A3B', A3B)}
${glslArray('int', 'W2', WEIGHTS[2]!)}${glslArray('int', 'W3', WEIGHTS[3]!)}${glslArray('int', 'W4', WEIGHTS[4]!)}
${(['NS', 'PB', 'RB', 'IS', 'CB', 'AB', 'EP', 'SP', 'IB', 'IB2'] as const)
  .map((name, f) =>
    glslArray(
      'int',
      'M' + name,
      MODES.map((m) => m[f]!),
    ),
  )
  .join('')}
uvec4 blk;int bp;
uint take(int n){if(n==0)return 0u;int i=bp>>5,o=bp&31;uint v=blk[i]>>uint(o);if(o+n>32&&i<3)v|=blk[i+1]<<uint(32-o);bp+=n;return v&((1u<<uint(n))-1u);}
int weight(int bits,int i){return bits==2?W2[i]:bits==3?W3[i]:W4[i];}
vec4 decodeTexel(ivec2 p){
 blk=blockAt(p.y>>2,(p.x>>2)*4);int t=(p.x&3)+(p.y&3)*4;
 int mode=0;while(mode<8&&((blk.x>>uint(mode))&1u)==0u)mode++;
 if(mode==8)return vec4(0.);
 bp=mode+1;int ns=MNS[mode],cb=MCB[mode],ab=MAB[mode],ib=MIB[mode],ib2=MIB2[mode];
 int part=int(take(MPB[mode])),rot=int(take(MRB[mode])),isb=int(take(MIS[mode]));
 ivec4 e[6];for(int i=0;i<6;i++)e[i]=ivec4(0,0,0,255);
 for(int c=0;c<3;c++)for(int i=0;i<2*ns;i++)e[i][c]=int(take(cb));
 if(ab>0)for(int i=0;i<2*ns;i++)e[i].w=int(take(ab));
 int pbits=0;
 if(MEP[mode]!=0){pbits=1;for(int i=0;i<2*ns;i++){int p=int(take(1));e[i].xyz=e[i].xyz*2+p;if(ab>0)e[i].w=e[i].w*2+p;}}
 if(MSP[mode]!=0){pbits=1;int p0=int(take(1)),p1=int(take(1));for(int i=0;i<2*ns;i++){int p=i<2?p0:p1;e[i].xyz=e[i].xyz*2+p;if(ab>0)e[i].w=e[i].w*2+p;}}
 for(int i=0;i<2*ns;i++){int n=cb+pbits;e[i].xyz=(e[i].xyz<<(8-n))|((e[i].xyz<<(8-n))>>n);if(ab>0){int m=ab+pbits;e[i].w=(e[i].w<<(8-m))|((e[i].w<<(8-m))>>m);}}
 int s=ns==1?0:ns==2?int((P2[part]>>uint(t))&1u):int((P3[part]>>uint(2*t))&3u);
 int a1=ns==2?A2[part]:ns==3?A3A[part]:-1,a2=ns==3?A3B[part]:-1;
 int start=bp,off=0,total=0;
 for(int i=0;i<16;i++){int w=(i==0||i==a1||i==a2)?ib-1:ib;if(i<t)off+=w;total+=w;}
 bp=start+off;int i1=int(take((t==0||t==a1||t==a2)?ib-1:ib));
 int ci=i1,cbits=ib,ai=i1,abits=ib;
 if(ib2>0){bp=start+total+(t==0?0:ib2*t-1);int i2=int(take(t==0?ib2-1:ib2));
  if(isb!=0){ci=i2;cbits=ib2;}else{ai=i2;abits=ib2;}}
 int wc=weight(cbits,ci),wa=weight(abits,ai);ivec4 e0=e[2*s],e1=e[2*s+1];
 ivec4 c=ivec4(((64-wc)*e0.xyz+wc*e1.xyz+32)>>6,((64-wa)*e0.w+wa*e1.w+32)>>6);
 if(rot==1)c=c.wyzx;else if(rot==2)c=c.xwzy;else if(rot==3)c=c.xywz;
 return vec4(c)/255.;
}`;

const BC = (format: 'bc1' | 'bc2' | 'bc3') => `
ivec3 rgb565(uint c){ivec3 v=ivec3(int((c>>11)&31u),int((c>>5)&63u),int(c&31u));return ivec3((v.x<<3)|(v.x>>2),(v.y<<2)|(v.y>>4),(v.z<<3)|(v.z>>2));}
vec4 decodeTexel(ivec2 p){
 int t=(p.x&3)+(p.y&3)*4;
 ${format === 'bc1' ? 'uvec4 w=uvec4(0u,0u,wordAt(p.y>>2,(p.x>>2)*2),wordAt(p.y>>2,(p.x>>2)*2+1));' : 'uvec4 w=blockAt(p.y>>2,(p.x>>2)*4);'}
 uint c0=w.z&0xffffu,c1=w.z>>16;ivec3 p0=rgb565(c0),p1=rgb565(c1);
 int index=int((w.w>>uint(2*t))&3u);ivec4 c;
 ${format === 'bc1' ? 'bool four=c0>c1;' : 'bool four=true;'}
 if(index==0)c=ivec4(p0,255);else if(index==1)c=ivec4(p1,255);
 else if(four)c=ivec4(index==2?(2*p0+p1)/3:(p0+2*p1)/3,255);
 else c=index==2?ivec4((p0+p1)>>1,255):ivec4(0);
 ${
   format === 'bc2'
     ? 'c.w=int((w[t>>3]>>uint((t&7)*4))&15u)*17;'
     : format === 'bc3'
       ? `int a0=int(w.x&255u),a1=int((w.x>>8)&255u);int bit=16+t*3;uint bits=0u;
 if(bit>=32)bits=w.y>>uint(bit-32);else{bits=w.x>>uint(bit);if(bit>29)bits|=w.y<<uint(32-bit);}
 int v=int(bits&7u);
 if(v==0)c.w=a0;else if(v==1)c.w=a1;
 else if(a0>a1)c.w=((8-v)*a0+(v-1)*a1)/7;
 else if(v<6)c.w=((6-v)*a0+(v-1)*a1)/5;else c.w=v==6?0:255;`
       : ''
 }
 return vec4(c)/255.;
}`;

const LINEAR: Record<'r8' | 'a8' | 'r8g8' | 'b8g8r8a8', string> = {
  r8: 'vec4 decodeTexel(ivec2 p){return vec4(float(byteAt(p.y,p.x))/255.,0.,0.,1.);}',
  a8: 'vec4 decodeTexel(ivec2 p){return vec4(0.,0.,0.,float(byteAt(p.y,p.x))/255.);}',
  r8g8: 'vec4 decodeTexel(ivec2 p){return vec4(float(byteAt(p.y,2*p.x))/255.,float(byteAt(p.y,2*p.x+1))/255.,0.,1.);}',
  b8g8r8a8: 'vec4 decodeTexel(ivec2 p){return texelFetch(atlas,p,0).zyxw;}',
};

/** Triangle `shade` program that writes the decoded texel at its pixel; UVs are pixels. */
export function gpuTextureDecodeFragment(format: GpuTextureFormat): string {
  const body =
    format === 'bc7' ? BC7 : isBlock(format) ? BC(format as 'bc1') : LINEAR[format as 'r8'];
  return `${FETCH}\n${body}\nvec4 shade(vec4 sampled,vec4 tint){return decodeTexel(ivec2(floor(tex)));}`;
}

const REPLACE: BlendState = {
  color: {source: 'one', destination: 'zero', operation: 'add'},
  alpha: {source: 'one', destination: 'zero', operation: 'add'},
};

/**
 * Commands that decode the packed upload `packed` (an id of the `packedGpuTexture` image)
 * into `surface`, which has the level's dimensions. They leave `surface` bound.
 */
export function gpuTextureDecodeCommands(
  format: GpuTextureFormat,
  packed: number,
  surface: GpuRenderSurface,
): DrawCommand[] {
  const w = surface.width,
    h = surface.height;
  const vertices = new Float32Array(
    [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ].flatMap(([x, y]) => [x!, y!, 0, 1, 1, 1, 1, x!, y!]),
  );
  return [
    {kind: 'gpu-target', surface, clearColor: [0, 0, 0, 0]},
    {
      kind: 'triangles',
      texture: packed,
      vertices,
      topology: 'triangle-strip',
      normalizedUV: true,
      filter: 'nearest',
      fragment: gpuTextureDecodeFragment(format),
      blendState: REPLACE,
      discardTransparent: false,
    },
  ];
}
