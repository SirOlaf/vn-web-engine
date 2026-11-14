/** Exact RGBA8 comparison on WebGL2, with integer OR reduction and batched numeric readback.
 * A zero vector proves equality at every texel/channel; this is not a probabilistic hash.
 * Source textures are borrowed. The caller establishes their dimensions and logical origins.
 * Calls change GL state; each rendering owner must reapply its own state before drawing. */
export class Rgba8TextureComparison {
  constructor(gl, batchSize = 32) {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > gl.getParameter(gl.MAX_TEXTURE_SIZE)
    )
      throw new Error('Invalid comparison batch size');
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.polygon = gl.getExtension('WEBGL_polygon_mode');
    this.uniforms = new Map();
    this.batchSize = batchSize;
    this.pending = [];
    this.levels = [];
    this.size = '';
    this.closed = false;
    this.programs = [];
    this.atlas = null;
    this.vao = null;
    try {
      this.vao = gl.createVertexArray();
      if (!this.vao) throw new Error('Comparison VAO allocation failed');
      const body = `#version 300 es
precision highp float;precision highp int;
layout(location=0) out uvec4 difference;
uniform ivec2 imageSize;
`;
      this.compare = this.program(
        body +
          `uniform highp sampler2D expectedImage;uniform highp sampler2D actualImage;
uniform bool flipExpected;uniform bool flipActual;
void main(){uvec4 bits=uvec4(0u);ivec2 base=ivec2(gl_FragCoord.xy)*16;
for(int y=0;y<16;y++)for(int x=0;x<16;x++){
ivec2 p=base+ivec2(x,y);if(any(greaterThanEqual(p,imageSize)))continue;
ivec2 e=p,a=p;if(flipExpected)e.y=imageSize.y-1-e.y;if(flipActual)a.y=imageSize.y-1-a.y;
bits|=uvec4(notEqual(texelFetch(expectedImage,e,0),texelFetch(actualImage,a,0)));}
difference=bits;}`,
      );
      this.reduce = this.program(
        body +
          `uniform highp usampler2D inputImage;
void main(){uvec4 bits=uvec4(0u);ivec2 base=ivec2(gl_FragCoord.xy)*16;
for(int y=0;y<16;y++)for(int x=0;x<16;x++){ivec2 p=base+ivec2(x,y);
if(all(lessThan(p,imageSize)))bits|=texelFetch(inputImage,p,0);}
difference=bits;}`,
      );
      this.atlas = this.target(batchSize, 1);
      this.error();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  program(fragment) {
    const gl = this.gl,
      shaders = [];
    let program = null;
    try {
      for (const [type, source] of [
        [
          gl.VERTEX_SHADER,
          '#version 300 es\nvoid main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}',
        ],
        [gl.FRAGMENT_SHADER, fragment],
      ]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Comparison shader allocation failed');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader));
      }
      program = gl.createProgram();
      if (!program) throw new Error('Comparison program allocation failed');
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
      this.programs.push(program);
      return program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }
  target(width, height) {
    const gl = this.gl,
      texture = gl.createTexture(),
      framebuffer = gl.createFramebuffer();
    try {
      if (!texture || !framebuffer) throw new Error('Comparison target allocation failed');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Incomplete integer comparison framebuffer');
      return {texture, framebuffer, width, height};
    } catch (error) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (texture) gl.deleteTexture(texture);
      throw error;
    }
  }
  uniform(program, name) {
    let fields = this.uniforms.get(program);
    if (!fields) {
      fields = new Map();
      this.uniforms.set(program, fields);
    }
    if (!fields.has(name)) fields.set(name, this.gl.getUniformLocation(program, name));
    return fields.get(name);
  }
  retire(target) {
    if (target) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
  }
  error() {
    if (this.gl.isContextLost()) throw new Error('RGBA8 comparison context lost');
    const error = this.gl.getError();
    if (error) throw new Error('RGBA8 comparison GL error ' + error);
  }
  state() {
    const gl = this.gl;
    for (const capability of [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.SCISSOR_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
      gl.SAMPLE_COVERAGE,
    ])
      gl.disable(capability);
    this.polygon?.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygon.FILL_WEBGL);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
    gl.bindSampler(0, null);
    gl.bindSampler(1, null);
  }
  enqueue(expected, actual, width, height, label, {flipExpected = false, flipActual = false} = {}) {
    if (this.closed) throw new Error('Using a closed RGBA8 comparator');
    if (this.gl.isContextLost()) throw new Error('RGBA8 comparison context lost');
    const gl = this.gl,
      max = this.maxSize;
    if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= max))
      throw new Error('Invalid comparison dimensions');
    if (!gl.isTexture(expected) || !gl.isTexture(actual))
      throw new Error('Comparison texture belongs to another context or is released');
    const size = width + 'x' + height;
    if (size !== this.size) {
      const levels = [];
      let w = width,
        h = height;
      try {
        do {
          w = Math.ceil(w / 16);
          h = Math.ceil(h / 16);
          levels.push(this.target(w, h));
        } while (w !== 1 || h !== 1);
      } catch (error) {
        for (const level of levels) this.retire(level);
        throw error;
      }
      for (const level of this.levels) this.retire(level);
      this.levels = levels;
      this.size = size;
    }
    this.state();
    gl.useProgram(this.compare);
    gl.uniform2i(this.uniform(this.compare, 'imageSize'), width, height);
    gl.uniform1i(this.uniform(this.compare, 'expectedImage'), 0);
    gl.uniform1i(this.uniform(this.compare, 'actualImage'), 1);
    gl.uniform1i(this.uniform(this.compare, 'flipExpected'), +flipExpected);
    gl.uniform1i(this.uniform(this.compare, 'flipActual'), +flipActual);
    for (const [unit, texture] of [
      [0, expected],
      [1, actual],
    ]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    for (let i = 0; i < this.levels.length; i++) {
      const target = this.levels[i];
      if (i) {
        const prior = this.levels[i - 1];
        gl.useProgram(this.reduce);
        gl.uniform1i(this.uniform(this.reduce, 'inputImage'), 0);
        gl.uniform2i(this.uniform(this.reduce, 'imageSize'), prior.width, prior.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prior.texture);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, target.width, target.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const last = this.levels.at(-1),
      slot = this.pending.length;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, last.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.atlas.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.blitFramebuffer(0, 0, 1, 1, slot, 0, slot + 1, 1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.error();
    this.pending.push(label);
    return this.pending.length === this.batchSize ? this.flush() : [];
  }
  flush() {
    if (this.closed) throw new Error('Using a closed RGBA8 comparator');
    if (this.gl.isContextLost()) throw new Error('RGBA8 comparison context lost');
    if (!this.pending.length) return [];
    const gl = this.gl,
      words = new Uint32Array(this.pending.length * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.atlas.framebuffer);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.readPixels(0, 0, this.pending.length, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, words);
    this.error();
    const rows = this.pending.map((label, i) => {
      const channels = Array.from(words.subarray(i * 4, i * 4 + 4));
      return {label, equal: channels.every((v) => v === 0), channels};
    });
    this.pending = [];
    return rows;
  }
  destroy() {
    for (const level of this.levels ?? []) this.retire(level);
    this.levels = [];
    this.retire(this.atlas);
    this.atlas = null;
    for (const program of this.programs ?? []) this.gl.deleteProgram(program);
    this.programs = [];
    this.uniforms.clear();
    if (this.vao) this.gl.deleteVertexArray(this.vao);
    this.vao = null;
    this.closed = true;
  }
  dispose() {
    if (this.closed) return [];
    try {
      return this.flush();
    } finally {
      this.destroy();
    }
  }
}
