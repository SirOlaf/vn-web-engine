/** Generic indexed 2D textured-mesh rendering; coordinates are centered, positive Y down. */
export interface TexturedMesh {
  vertices: Float32Array;
  indices: Uint16Array;
}
export class TexturedMeshRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vertexBuffers = new Map<Float32Array, WebGLBuffer>();
  private readonly indexBuffers = new Map<Uint16Array, WebGLBuffer>();
  private readonly view: WebGLUniformLocation;
  private readonly position: number;
  private readonly uv: number;
  constructor(
    readonly canvas: HTMLCanvasElement,
    image: TexImageSource,
  ) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL is required for character composition');
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error('Cannot allocate mesh shader');
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? 'Mesh shader failed');
      return s;
    };
    const vs = shader(
      gl.VERTEX_SHADER,
      'attribute vec3 position;attribute vec2 uv;uniform vec4 view;varying highp vec2 tex;void main(){gl_Position=vec4((position.x-view.x)*2./view.z,-(position.y-view.y)*2./view.w,0.,1.);tex=uv;}',
    );
    const fs = shader(
      gl.FRAGMENT_SHADER,
      'precision highp float;uniform sampler2D atlas;varying highp vec2 tex;void main(){gl_FragColor=texture2D(atlas,tex);}',
    );
    const program = gl.createProgram();
    if (!program) throw new Error('Cannot allocate mesh program');
    this.program = program;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('Mesh program link failed');
    gl.useProgram(program);
    const view = gl.getUniformLocation(program, 'view');
    if (!view) throw new Error('Missing mesh transform');
    this.view = view;
    this.position = gl.getAttribLocation(program, 'position');
    this.uv = gl.getAttribLocation(program, 'uv');
    gl.enableVertexAttribArray(this.position);
    gl.enableVertexAttribArray(this.uv);
    const texture = gl.createTexture();
    if (!texture) throw new Error('Cannot allocate atlas texture');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error('Character atlas exceeds graphics device limits');
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
  }
  draw(
    meshes: readonly TexturedMesh[],
    width: number,
    height: number,
    centerX = 0,
    centerY = 0,
  ): void {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Character graphics context was lost');
    this.canvas.width = Math.min(2048, Math.ceil(width));
    this.canvas.height = Math.ceil((this.canvas.width * height) / width);
    if (this.canvas.height > 2048) {
      this.canvas.height = 2048;
      this.canvas.width = Math.ceil((2048 * width) / height);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(this.view, centerX, centerY, width, height);
    for (const mesh of meshes) {
      let vb = this.vertexBuffers.get(mesh.vertices);
      if (!vb) {
        vb = gl.createBuffer() ?? undefined;
        if (!vb) throw new Error('Cannot allocate mesh vertices');
        this.vertexBuffers.set(mesh.vertices, vb);
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      } else gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.vertexAttribPointer(this.position, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(this.uv, 2, gl.FLOAT, false, 20, 12);
      let ib = this.indexBuffers.get(mesh.indices);
      if (!ib) {
        ib = gl.createBuffer() ?? undefined;
        if (!ib) throw new Error('Cannot allocate mesh indices');
        this.indexBuffers.set(mesh.indices, ib);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      } else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    }
  }
  dispose(): void {
    for (const b of this.vertexBuffers.values()) this.gl.deleteBuffer(b);
    for (const b of this.indexBuffers.values()) this.gl.deleteBuffer(b);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
