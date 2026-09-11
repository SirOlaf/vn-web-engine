import type {BlendFactor, BlendOperation, BlendState} from './blend.js';
import type {DrawList, DrawCommand, SpriteDraw, SolidDraw} from './draw-list.js';
import type {TriangleDraw, TriangleImage} from './triangle-draw.js';
interface DrawProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attributes: Map<string, number>;
  layouts: Map<string, WebGLVertexArrayObject>;
}
/** Straight RGBA rendering, with independent color/alpha blending and explicit copies.
 * Pixel ownership stays with the caller; presentation is opaque. */
export class WebGLDrawTarget {
  private surface: HTMLCanvasElement | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private framebuffer: WebGLFramebuffer | undefined;
  private color: WebGLTexture | undefined;
  private activeFramebuffer: WebGLFramebuffer | undefined;
  private activeWidth = 0;
  private activeHeight = 0;
  private buffer: WebGLBuffer | undefined;
  private readonly programs = new Map<string, DrawProgram>();
  private maxTextureUnits = 0;
  private readonly samplers = new Map<string, WebGLSampler>();
  private readonly images = new Map<object, WebGLTexture>();
  private readonly white: TriangleImage = {
    width: 1,
    height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]),
  };
  private readonly context: CanvasRenderingContext2D;
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly width: number,
    readonly height: number,
    readonly options: {batchMasks?: boolean; transparent?: boolean} = {},
  ) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error('Invalid target dimensions');
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('Canvas presentation unavailable');
    this.context = c;
  }
  private initialize(): WebGL2RenderingContext {
    if (this.gl) return this.gl;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const gl = canvas.getContext('webgl2', {
      alpha: this.options.transparent ?? false,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL 2 rendering unavailable');
    this.gl = gl;
    this.surface = canvas;
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    const framebuffer = gl.createFramebuffer(),
      buffer = gl.createBuffer(),
      color = gl.createTexture();
    if (!framebuffer || !buffer || !color) throw new Error('Cannot allocate rendering target');
    this.framebuffer = framebuffer;
    this.activeFramebuffer = framebuffer;
    this.activeWidth = this.width;
    this.activeHeight = this.height;
    this.buffer = buffer;
    this.color = color;
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Incomplete rendering framebuffer');
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.BLEND);
    return gl;
  }
  private program(
    fragment = 'vec4 shade(vec4 sampleColor,vec4 tint){return sampleColor*tint;}',
    discardTransparent = true,
    extraCount = 3,
  ): DrawProgram {
    const key = fragment + discardTransparent + '/' + extraCount,
      cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.initialize();
    const compile = (type: number, text: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Cannot allocate shader');
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
      return shader;
    };
    const indices = Array.from({length: extraCount}, (_, i) => i);
    const vs = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
precision highp float;in vec3 position;in vec4 color;in vec2 uv;in vec2 maskCoordinates;${indices.map((i) => `in vec2 additionalCoordinates${i};out vec2 additionalUV${i};`).join('')}uniform mat4 transform;uniform bool depthClip;uniform vec2 textureSize;out vec4 tint;out vec2 tex;out vec2 maskUV;void main(){${indices.map((i) => `additionalUV${i}=additionalCoordinates${i};`).join('')}gl_Position=transform*vec4(position,1.);if(!depthClip)gl_Position.z=0.;gl_PointSize=1.;tex=uv/textureSize;maskUV=maskCoordinates;tint=color;}`,
    );
    const fs = compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision highp float;uniform sampler2D atlas;uniform sampler2D maskAtlas;${indices.map((i) => `uniform sampler2D additionalAtlas${i};`).join('')}uniform vec4 parameters[8];${indices.map((i) => `in vec2 additionalUV${i};`).join('')}uniform vec4 maskMode;uniform vec2 threshold;in vec4 tint;in vec2 tex;in vec2 maskUV;out vec4 outputColor;${fragment}
void main(){vec4 sampled=texture(atlas,tex);if(maskMode.w!=0.)sampled.rgb=vec3(1.);vec4 c=shade(sampled,tint);if(maskMode.x!=0.){vec4 m=texture(maskAtlas,maskUV);float a=mix(m.a,m.r,maskMode.y);a=mix(a,1.-a,maskMode.z);c.a*=clamp(a*threshold.x-threshold.y,0.,1.);}${discardTransparent ? 'if(c.a<=0.)discard;' : ''}outputColor=c;}`,
    );
    const p = gl.createProgram();
    if (!p) throw new Error('Cannot allocate program');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) ?? 'Shader link failed');
    const entry: DrawProgram = {
      program: p,
      uniforms: new Map(),
      attributes: new Map(),
      layouts: new Map(),
    };
    for (const name of [
      'depthClip',
      'transform',
      'textureSize',
      'atlas',
      'maskAtlas',
      'maskMode',
      'threshold',
      'parameters[0]',
      ...indices.map((i) => `additionalAtlas${i}`),
    ])
      entry.uniforms.set(name, gl.getUniformLocation(p, name));
    for (const name of [
      'position',
      'color',
      'uv',
      'maskCoordinates',
      ...indices.map((i) => `additionalCoordinates${i}`),
    ])
      entry.attributes.set(name, gl.getAttribLocation(p, name));
    this.programs.set(key, entry);
    return entry;
  }
  private bind(
    image: TriangleImage,
    unit: number,
    filter: 'nearest' | 'linear' = 'linear',
    wrapS: 'clamp' | 'repeat' | 'mirror' = 'clamp',
    wrapT: 'clamp' | 'repeat' | 'mirror' = 'clamp',
  ): void {
    const gl = this.initialize();
    gl.activeTexture(gl.TEXTURE0 + unit);
    let texture = this.images.get(image);
    if (!texture) {
      texture = gl.createTexture() ?? undefined;
      if (!texture) throw new Error('Cannot allocate texture');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Texture upload failed');
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.images.set(image, texture);
    } else gl.bindTexture(gl.TEXTURE_2D, texture);
    // Sampler state belongs to a binding, not to the cached image. One image may
    // be used by several texture units with different filters in the same draw.
    const key = `${filter}/${wrapS}/${wrapT}`;
    let sampler = this.samplers.get(key);
    if (!sampler) {
      sampler = gl.createSampler() ?? undefined;
      if (!sampler) throw new Error('Cannot allocate sampler');
      const wrap = {clamp: gl.CLAMP_TO_EDGE, repeat: gl.REPEAT, mirror: gl.MIRRORED_REPEAT};
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap[wrapS]);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap[wrapT]);
      gl.samplerParameteri(
        sampler,
        gl.TEXTURE_MIN_FILTER,
        filter === 'nearest' ? gl.NEAREST : gl.LINEAR,
      );
      gl.samplerParameteri(
        sampler,
        gl.TEXTURE_MAG_FILTER,
        filter === 'nearest' ? gl.NEAREST : gl.LINEAR,
      );
      this.samplers.set(key, sampler);
    }
    gl.bindSampler(unit, sampler);
  }
  private blend(state: BlendState | undefined, additive: boolean): void {
    const gl = this.initialize(),
      factor = (v: BlendFactor) =>
        ({
          zero: gl.ZERO,
          one: gl.ONE,
          'source-color': gl.SRC_COLOR,
          'inverse-source-color': gl.ONE_MINUS_SRC_COLOR,
          'source-alpha': gl.SRC_ALPHA,
          'inverse-source-alpha': gl.ONE_MINUS_SRC_ALPHA,
          'destination-color': gl.DST_COLOR,
          'inverse-destination-color': gl.ONE_MINUS_DST_COLOR,
          'destination-alpha': gl.DST_ALPHA,
          'inverse-destination-alpha': gl.ONE_MINUS_DST_ALPHA,
        })[v],
      op = (v: BlendOperation) =>
        ({
          add: gl.FUNC_ADD,
          subtract: gl.FUNC_SUBTRACT,
          'reverse-subtract': gl.FUNC_REVERSE_SUBTRACT,
          min: gl.MIN,
          max: gl.MAX,
        })[v];
    if (state) {
      gl.blendFuncSeparate(
        factor(state.color.source),
        factor(state.color.destination),
        factor(state.alpha.source),
        factor(state.alpha.destination),
      );
      gl.blendEquationSeparate(op(state.color.operation), op(state.alpha.operation));
    } else {
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    }
  }
  private paint(
    draw: TriangleDraw,
    image: TriangleImage,
    mask?: {settings: NonNullable<TriangleDraw['mask']>; image: TriangleImage},
    additional: TriangleImage[] = [],
  ): void {
    const extras = draw.additionalTextures ?? [],
      extraCount = Math.max(3, extras.length),
      gl = this.initialize();
    if (extras.length + 2 > this.maxTextureUnits)
      throw new Error('Texture bindings exceed WebGL fragment texture units');
    const p = this.program(draw.fragment, draw.discardTransparent, extraCount);
    if (draw.vertices.length % 9 || !draw.vertices.every(Number.isFinite))
      throw new Error('Invalid primitive vertices');
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
    const masks = mask ? [mask.settings.uv] : [],
      coordinates = [...masks, ...extras.map((t) => t.uv)];
    let data = draw.vertices;
    const size = 9 + coordinates.length * 2,
      stride = size * 4;
    for (const uv of coordinates)
      if (uv.length !== (draw.vertices.length / 9) * 2)
        throw new Error('Texture coordinates do not match vertex count');
    if (coordinates.length) {
      data = new Float32Array((draw.vertices.length / 9) * size);
      for (let i = 0; i < draw.vertices.length / 9; i++) {
        data.set(draw.vertices.subarray(i * 9, i * 9 + 9), i * size);
        coordinates.forEach((uv, j) =>
          data.set(uv.subarray(i * 2, i * 2 + 2), i * size + 9 + j * 2),
        );
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    // A VAO owns attribute enables, pointers and the shared streaming-buffer binding.
    // Layout changes never change the uploaded floats or the primitive sequence.
    const layoutKey = `${mask ? 1 : 0}/${extras.length}`;
    let layout = p.layouts.get(layoutKey);
    if (!layout) {
      layout = gl.createVertexArray() ?? undefined;
      if (!layout) throw new Error('Cannot allocate vertex layout');
      gl.bindVertexArray(layout);
      for (const [name, size, offset] of [
        ['position', 3, 0],
        ['color', 4, 12],
        ['uv', 2, 28],
      ] as const) {
        const a = p.attributes.get(name)!;
        if (a >= 0) {
          gl.enableVertexAttribArray(a);
          gl.vertexAttribPointer(a, size, gl.FLOAT, false, stride, offset);
        }
      }
      const maskAttribute = p.attributes.get('maskCoordinates')!;
      if (maskAttribute >= 0) {
        if (mask) {
          gl.enableVertexAttribArray(maskAttribute);
          gl.vertexAttribPointer(maskAttribute, 2, gl.FLOAT, false, stride, 36);
        } else {
          gl.disableVertexAttribArray(maskAttribute);
          gl.vertexAttrib2f(maskAttribute, 0, 0);
        }
      }
      for (let i = 0; i < extraCount; i++) {
        const attribute = p.attributes.get(`additionalCoordinates${i}`)!;
        if (attribute >= 0) {
          if (extras[i]) {
            gl.enableVertexAttribArray(attribute);
            gl.vertexAttribPointer(
              attribute,
              2,
              gl.FLOAT,
              false,
              stride,
              36 + (masks.length + i) * 8,
            );
          } else {
            gl.disableVertexAttribArray(attribute);
            gl.vertexAttrib2f(attribute, 0, 0);
          }
        }
      }
      p.layouts.set(layoutKey, layout);
    } else gl.bindVertexArray(layout);
    const uniform = (name: string) => p.uniforms.get(name) ?? null;
    gl.uniform1i(uniform('depthClip'), draw.depthClip === false ? 0 : 1);
    gl.uniformMatrix4fv(
      uniform('transform'),
      false,
      draw.transform ??
        new Float32Array([
          2 / this.activeWidth,
          0,
          0,
          0,
          0,
          -2 / this.activeHeight,
          0,
          0,
          0,
          0,
          0,
          0,
          -1,
          1,
          0,
          1,
        ]),
    );
    this.bind(image, 0, draw.filter, draw.wrapS, draw.wrapT);
    gl.uniform1i(uniform('atlas'), 0);
    gl.uniform2f(
      uniform('textureSize'),
      draw.normalizedUV ? 1 : image.width,
      draw.normalizedUV ? 1 : image.height,
    );
    if (mask) {
      const m = mask.settings;
      this.bind(mask.image, 1, m.filter, m.wrapS, m.wrapT);
      gl.uniform1i(uniform('maskAtlas'), 1);
      gl.uniform4f(
        uniform('maskMode'),
        1,
        m.channel === 'red' ? 1 : 0,
        m.invert ? 1 : 0,
        m.alphaOnly ? 1 : 0,
      );
      gl.uniform2f(uniform('threshold'), m.scale, m.bias);
    } else {
      gl.uniform4f(uniform('maskMode'), 0, 0, 0, 0);
      gl.uniform1i(uniform('maskAtlas'), 0);
    }
    const parameters = draw.parameters ?? new Float32Array(32);
    if (parameters.length % 4 || parameters.length > 32)
      throw new Error('Invalid shader parameters');
    gl.uniform4fv(uniform('parameters[0]'), parameters);
    for (let i = 0; i < extras.length; i++) {
      const t = extras[i]!;
      this.bind(additional[i]!, 2 + i, t.filter, t.wrapS, t.wrapT);
      gl.uniform1i(uniform(`additionalAtlas${i}`), 2 + i);
    }
    this.blend(draw.blendState, draw.blend === 'add');
    const topology = draw.topology ?? 'triangles';
    gl.drawArrays(
      {
        points: gl.POINTS,
        lines: gl.LINES,
        'line-strip': gl.LINE_STRIP,
        triangles: gl.TRIANGLES,
        'triangle-strip': gl.TRIANGLE_STRIP,
      }[topology],
      0,
      draw.vertices.length / 9,
    );
  }
  private rectangle(draw: SpriteDraw | SolidDraw): TriangleDraw {
    const d = draw.destination,
      s = 'kind' in draw ? {x: 0, y: 0, width: 1, height: 1} : draw.source,
      vertices: number[] = [],
      r = ((draw.color >>> 16) & 255) / 255,
      g = ((draw.color >>> 8) & 255) / 255,
      b = (draw.color & 255) / 255,
      alpha = Math.max(0, Math.min(255, draw.alpha)) / 255;
    if (![d.x, d.y, d.width, d.height, s.x, s.y, s.width, s.height].every(Number.isFinite))
      throw new Error('Invalid rectangle');
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 1],
      [1, 0],
      [1, 1],
    ])
      vertices.push(
        d.x + x! * d.width,
        d.y + y! * d.height,
        0,
        r,
        g,
        b,
        alpha,
        s.x + x! * s.width,
        s.y + y! * s.height,
      );
    return {
      kind: 'triangles',
      texture: 'kind' in draw ? -1 : draw.texture,
      vertices: new Float32Array(vertices),
      blendState: draw.blendState,
      ...('kind' in draw
        ? {}
        : {
            blend: draw.blend,
            filter: draw.filter,
            fragment: draw.fragment,
            wrapS: draw.wrapS,
            wrapT: draw.wrapT,
          }),
    };
  }
  private capture(width: number, height: number): TriangleImage {
    const gl = this.initialize();
    if (width < 1 || height < 1 || !Number.isInteger(width) || !Number.isInteger(height))
      throw new Error('Invalid capture dimensions');
    let target: WebGLFramebuffer | null = null,
      texture: WebGLTexture | null = null;
    if (width !== this.activeWidth || height !== this.activeHeight) {
      target = gl.createFramebuffer();
      texture = gl.createTexture();
      if (!target || !texture) throw new Error('Cannot allocate capture');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.activeFramebuffer!);
      gl.blitFramebuffer(
        0,
        0,
        this.activeWidth,
        this.activeHeight,
        0,
        0,
        width,
        height,
        gl.COLOR_BUFFER_BIT,
        gl.LINEAR,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target);
    }
    const raw = new Uint8Array(width * height * 4),
      pixels = new Uint8Array(raw.length);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < height; y++)
      pixels.set(
        raw.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
        y * width * 4,
      );
    if (target) gl.deleteFramebuffer(target);
    if (texture) gl.deleteTexture(texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.activeFramebuffer!);
    return {width, height, pixels};
  }
  draw(
    list: DrawList,
    texture: (id: number) => TriangleImage,
    writeTexture?: (id: number, image: TriangleImage, command?: DrawCommand) => void,
    layers?: {
      after: ReadonlySet<DrawCommand>;
      omit: ReadonlySet<DrawCommand>;
      present: (surface: HTMLCanvasElement | undefined, after?: DrawCommand) => void;
    },
  ): void {
    const gl = this.initialize();
    if (gl.isContextLost()) throw new Error('Graphics context lost');
    this.activeFramebuffer = this.framebuffer;
    this.activeWidth = this.width;
    this.activeHeight = this.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer!);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const copies = new Map<number, TriangleImage>(),
      used = new Set<object>(),
      get = (id: number) => {
        const image = copies.get(id) ?? texture(id);
        used.add(image);
        return image;
      };
    used.add(this.white);
    const targets = new Map<
      number,
      {framebuffer: WebGLFramebuffer; color: WebGLTexture; width: number; height: number}
    >();
    let active: number | null = null,
      dirty = true;
    const publish = () => {
      if (active !== null) {
        const image = this.capture(this.activeWidth, this.activeHeight);
        copies.set(active, image);
        writeTexture?.(active, image);
      }
    };
    const target = (id: number | null, width: number, height: number) => {
      if (id === active) return;
      publish();
      active = id;
      if (id === null) {
        this.activeFramebuffer = this.framebuffer;
        this.activeWidth = this.width;
        this.activeHeight = this.height;
      } else {
        let value = targets.get(id);
        if (!value) {
          const framebuffer = gl.createFramebuffer(),
            color = gl.createTexture();
          if (!framebuffer || !color) throw new Error('Cannot allocate texture render target');
          const source = get(id);
          if (source.width !== width || source.height !== height)
            throw new Error('Render target dimensions do not match its texture');
          const pixels = new Uint8Array(source.pixels.length);
          for (let y = 0; y < height; y++)
            pixels.set(
              source.pixels.subarray(y * width * 4, (y + 1) * width * 4),
              (height - 1 - y) * width * 4,
            );
          gl.bindTexture(gl.TEXTURE_2D, color);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA8,
            width,
            height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            pixels,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Incomplete texture render target');
          value = {framebuffer, color, width, height};
          targets.set(id, value);
        }
        this.activeFramebuffer = value.framebuffer;
        this.activeWidth = value.width;
        this.activeHeight = value.height;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.activeFramebuffer!);
      gl.viewport(0, 0, this.activeWidth, this.activeHeight);
    };
    const present = (after?: DrawCommand) => {
      if (!dirty) {
        layers!.present(undefined, after);
        return;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer!);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0,
        0,
        this.width,
        this.height,
        0,
        0,
        this.width,
        this.height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      layers!.present(this.surface!, after);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer!);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      dirty = false;
    };
    for (const draw of list.commands ?? list.sprites) {
      if (layers?.omit.has(draw)) {
        if (active === null && layers.after.has(draw)) present(draw);
        continue;
      }
      if (
        active === null &&
        (!('kind' in draw) || draw.kind === 'solid' || draw.kind === 'triangles')
      )
        dirty = true;
      if ('kind' in draw) {
        if (draw.kind === 'texture') {
          const old = targets.get(draw.texture),
            wasActive = active === draw.texture;
          copies.set(draw.texture, draw.image);
          if (old) {
            gl.deleteFramebuffer(old.framebuffer);
            gl.deleteTexture(old.color);
            targets.delete(draw.texture);
          }
          if (wasActive) {
            active = null;
            target(draw.texture, draw.image.width, draw.image.height);
          }
        } else if (draw.kind === 'target') {
          target(draw.texture, draw.width, draw.height);
        } else if (draw.kind === 'capture') {
          const image = this.capture(draw.width, draw.height);
          copies.set(draw.texture, image);
          const cached = targets.get(draw.texture);
          if (cached) {
            if (cached.width !== image.width || cached.height !== image.height)
              throw new Error('Captured render target dimensions changed');
            const pixels = new Uint8Array(image.pixels.length);
            for (let y = 0; y < image.height; y++)
              pixels.set(
                image.pixels.subarray(y * image.width * 4, (y + 1) * image.width * 4),
                (image.height - 1 - y) * image.width * 4,
              );
            gl.bindTexture(gl.TEXTURE_2D, cached.color);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              image.width,
              image.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
          }
          writeTexture?.(draw.texture, image, draw);
        } else if (draw.kind === 'triangles')
          this.paint(
            draw,
            get(draw.texture),
            draw.mask ? {settings: draw.mask, image: get(draw.mask.texture)} : undefined,
            draw.additionalTextures?.map((t) => get(t.texture)),
          );
        else this.paint(this.rectangle(draw), this.white);
      } else if (draw.destination.width && draw.destination.height) {
        const mesh = this.rectangle(draw);
        let mask: Parameters<WebGLDrawTarget['paint']>[2];
        if (draw.mask) {
          const image = get(draw.mask.texture),
            s = draw.mask.source,
            uv = new Float32Array(12);
          for (const [i, [x, y]] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [0, 1],
            [1, 0],
            [1, 1],
          ].entries()) {
            uv[i * 2] = (s.x + x! * s.width) / image.width;
            uv[i * 2 + 1] = (s.y + y! * s.height) / image.height;
          }
          mask = {settings: {...draw.mask, uv}, image};
        }
        this.paint(mesh, get(draw.texture), mask);
      }
      if (layers && active === null && layers.after.has(draw)) present(draw);
    }
    publish();
    if (layers) present();
    for (const t of targets.values()) {
      gl.deleteFramebuffer(t.framebuffer);
      gl.deleteTexture(t.color);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer!);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    this.context.globalAlpha = 1;
    this.context.globalCompositeOperation = 'copy';
    this.context.drawImage(this.surface!, 0, 0);
    for (const [image, t] of this.images)
      if (!used.has(image)) {
        gl.deleteTexture(t);
        this.images.delete(image);
      }
  }
  invalidate(image: object): void {
    const t = this.images.get(image);
    if (t) {
      this.gl?.deleteTexture(t);
      this.images.delete(image);
    }
  }
  dispose(): void {
    const gl = this.gl;
    if (gl) {
      for (const t of this.images.values()) gl.deleteTexture(t);
      for (const p of this.programs.values()) {
        for (const layout of p.layouts.values()) gl.deleteVertexArray(layout);
        gl.deleteProgram(p.program);
      }
      gl.deleteBuffer(this.buffer!);
      gl.deleteFramebuffer(this.framebuffer!);
      gl.deleteTexture(this.color!);
      for (const sampler of this.samplers.values()) gl.deleteSampler(sampler);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.images.clear();
    this.programs.clear();
    this.samplers.clear();
    this.gl = undefined;
    this.surface = undefined;
    this.buffer = undefined;
    this.framebuffer = undefined;
    this.color = undefined;
    this.maxTextureUnits = 0;
  }
}
