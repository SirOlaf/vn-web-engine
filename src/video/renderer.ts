import type {YuvFrame} from './frame.js';
/** Reusable GPU YCbCr 4:2:0 renderer; MPEG-1 limited-range BT.601, centered chroma. */
export class YuvRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly textures: WebGLTexture[] = [];
  private readonly scale: WebGLUniformLocation;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL is required for movie rendering');
    this.gl = gl;
    function shader(type: number, source: string): WebGLShader {
      const s = gl!.createShader(type);
      if (!s) throw new Error('Cannot allocate shader');
      gl!.shaderSource(s, source);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS))
        throw new Error(`Video shader: ${gl!.getShaderInfoLog(s)}`);
      return s;
    }
    const vs = shader(
      gl.VERTEX_SHADER,
      'attribute vec2 position; uniform vec2 scale; varying vec2 uv; void main(){ gl_Position=vec4(position,0.,1.); uv=vec2(position.x+1.,1.-position.y)*.5*scale; }',
    );
    const fs = shader(
      gl.FRAGMENT_SHADER,
      'precision mediump float; varying vec2 uv; uniform sampler2D planeY; uniform sampler2D planeCb; uniform sampler2D planeCr; void main(){ float y=(texture2D(planeY,uv).r-16./255.)*(255./219.); float cb=(texture2D(planeCb,uv).r-128./255.)*(255./224.); float cr=(texture2D(planeCr,uv).r-128./255.)*(255./224.); gl_FragColor=vec4(y+1.402*cr,y-.344136*cb-.714136*cr,y+1.772*cb,1.); }',
    );
    const program = gl.createProgram();
    if (!program) throw new Error('Cannot allocate video program');
    this.program = program;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('Cannot link video shader');
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Cannot allocate video geometry');
    this.buffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const scale = gl.getUniformLocation(program, 'scale');
    if (!scale) throw new Error('Missing video uniform');
    this.scale = scale;
    for (const [i, name] of ['planeY', 'planeCb', 'planeCr'].entries()) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('Cannot allocate video texture');
      this.textures.push(tex);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }
  draw(frame: YuvFrame): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Video graphics context was lost; reopen this movie');
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    gl.viewport(0, 0, frame.width, frame.height);
    gl.uniform2f(this.scale, frame.width / frame.stride, frame.height / frame.paddedHeight);
    for (const [i, plane] of [frame.y, frame.cb, frame.cr].entries()) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]!);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        frame.stride / (i ? 2 : 1),
        frame.paddedHeight / (i ? 2 : 1),
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        plane,
      );
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose(): void {
    for (const tex of this.textures) this.gl.deleteTexture(tex);
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
