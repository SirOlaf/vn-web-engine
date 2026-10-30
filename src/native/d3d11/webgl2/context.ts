import type {ID3D11DeviceContext} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {D3d11IndexReader, D3d11VertexReader} from '../runtime/input-assembly.js';
import {D3d11InputLayout} from '../runtime/input-layout.js';
import {D3d11Shader} from '../runtime/shaders.js';
import {D3d11GpuOutput, type D3d11DrawOutputState} from './output.js';
import {D3d11GpuSamplers} from './samplers.js';
import {D3d11ProgramCache, type D3d11LinkedProgram} from './shaders.js';
import {D3d11GpuTextures, D3d11TextureError} from './textures.js';
import {D3d11TransferContext} from './transfers.js';

const MAX_FLOATS = 16 * 1024 * 1024;
const MAX_VERTICES = MAX_FLOATS / 4;
const uint = (n: number) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
type Mutable<T> = {-readonly [P in keyof T]: T[P]};

/** Native immediate context over shared owned bindings, transfers and GPU execution. */
export class D3d11DrawContext extends D3d11TransferContext implements ID3D11DeviceContext {
  private vertices = new Float32Array(0);
  /** Per-slot vertex scratch of the staged draw. */
  private slots = new Float64Array(0);
  private vertexArray: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private enabledAttributes = 0;
  /** Vertex array pointer offsets by location; the array never sets a divisor. */
  private readonly attributeOffsets: number[] = [];
  private gpuDisposed = false;
  private pendingDraw = false;
  private readonly outputState: Mutable<D3d11DrawOutputState>;

  constructor(
    private readonly drawOwner: D3d11DeviceOwner,
    gl: WebGL2RenderingContext,
    textures: D3d11GpuTextures,
    private readonly output: D3d11GpuOutput,
    private readonly programs: D3d11ProgramCache,
    private readonly samplers: D3d11GpuSamplers,
  ) {
    super(drawOwner, gl, textures);
    this.outputState = {
      targets: this.renderTargets,
      depthTarget: null,
      blend: null,
      blendFactor: this.blendFactor,
      sampleMask: this.sampleMask,
      depth: null,
      stencilRef: 0,
      raster: null,
      viewports: this.viewports,
      scissors: this.scissorRects,
    };
  }

  draw(vertexCount: number, startVertexLocation: number): void {
    this.checkLive();
    if (!uint(vertexCount) || !uint(startVertexLocation))
      throw new D3d11TextureError('Invalid D3D11 draw arguments');
    if (vertexCount) this.execute(vertexCount, startVertexLocation, 0, null);
  }

  drawIndexed(indexCount: number, startIndexLocation: number, baseVertexLocation: number): void {
    this.checkLive();
    if (
      !uint(indexCount) ||
      !uint(startIndexLocation) ||
      !Number.isInteger(baseVertexLocation) ||
      baseVertexLocation < -0x80000000 ||
      baseVertexLocation > 0x7fffffff
    )
      throw new D3d11TextureError('Invalid D3D11 indexed draw arguments');
    if (!indexCount) return;
    if (!this.indexBuffer) throw new D3d11TextureError('Unbound D3D11 index buffer');
    const indices = new D3d11IndexReader(
      this.drawOwner,
      this.indexBuffer,
      this.indexFormat,
      this.indexOffset,
    );
    this.execute(indexCount, startIndexLocation, baseVertexLocation, indices);
  }

  override flush(): void {
    super.flush();
    this.checkSubmission();
  }

  /** Shared-image publication: host-visible GL state and device removal are settled, while
   * queued GPU errors stay pending for flush and the next allocation, transfer or readback. */
  publish(): void {
    this.checkLive();
    this.output.invalidateState();
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
  }

  /** Backend submission boundary; CPU binding validation remains synchronous. */
  checkSubmission(): void {
    this.checkLive();
    this.output.invalidateState();
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
    const texturesChecked = this.textures.checkSubmission();
    if (!this.pendingDraw) return;
    this.pendingDraw = false;
    if (texturesChecked) return;
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) throw new D3d11TextureError('D3D11 draw failed: ' + error);
  }

  /** Device-lifetime callback, separate from clearing native context bindings. */
  disposeGpu(): void {
    if (this.gpuDisposed) return;
    this.gpuDisposed = true;
    const errors: unknown[] = [];
    for (const action of [
      () => this.gl.deleteVertexArray(this.vertexArray),
      () => this.gl.deleteBuffer(this.vertexBuffer),
    ])
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    this.vertexArray = null;
    this.vertexBuffer = null;
    this.enabledAttributes = 0;
    this.attributeOffsets.length = 0;
    this.vertices = new Float32Array(0);
    this.slots = new Float64Array(0);
    if (errors.length) throw new AggregateError(errors, 'D3D11 draw storage disposal failed');
  }

  private execute(
    count: number,
    start: number,
    base: number,
    indices: D3d11IndexReader | null,
  ): void {
    if (this.gpuDisposed) throw new D3d11TextureError('Using disposed D3D11 draw storage');
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
    const gl = this.gl,
      mode = [gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP][
        this.topology - 1
      ];
    if (mode === undefined)
      throw new D3d11TextureError('Unsupported D3D11 primitive topology', 0x80004001 | 0);
    if (!(this.vertexShader instanceof D3d11Shader) || !(this.pixelShader instanceof D3d11Shader))
      throw new D3d11TextureError(
        'The SM4 draw subset requires vertex and pixel shaders',
        0x80004001 | 0,
      );
    // A8 storage is red; its targets and views select a program variant.
    let alphaTargets = 0,
      alphaSamples = 0,
      reflectedSamples = 0;
    for (let i = 0; i < this.renderTargets.length; i++)
      if (this.renderTargets[i]?.resource.getDesc().format === 65) alphaTargets |= 1 << i;
    const samples = this.pixelShader.shader.code.samples;
    for (let i = 0; i < samples.length; i++) {
      const view = this.psResources[samples[i]!.resource],
        sampler = this.psSamplers[samples[i]!.sampler]?.description;
      if (view?.resource.getDesc().format === 65) alphaSamples |= 1 << i;
      // Point/clamp rows of a reflected view are selected in the shader, which
      // avoids refreshing a row-reflected copy after every target revision.
      if (
        view &&
        sampler &&
        (sampler.filter & 0x14) === 0 &&
        sampler.addressV === 3 &&
        this.textures.reflectable(view)
      )
        reflectedSamples |= 1 << i;
    }
    const program = this.programs.use(
        this.vertexShader,
        this.pixelShader,
        alphaTargets,
        alphaSamples,
        reflectedSamples,
      ),
      registers = program.attributes.map((a) => a.register),
      floats = count * registers.length * 4;
    if (count > MAX_VERTICES || floats > MAX_FLOATS)
      throw new D3d11TextureError('D3D11 draw exceeds bounded vertex staging', 0x8007000e | 0);
    let vertices: D3d11VertexReader | null = null;
    if (registers.length) {
      if (!(this.inputLayout instanceof D3d11InputLayout))
        throw new D3d11TextureError('Unbound D3D11 input layout');
      vertices = new D3d11VertexReader(
        this.drawOwner,
        this.inputLayout,
        registers,
        this.vertexBuffers,
        this.vertexStrides,
        this.vertexOffsets,
      );
      try {
        if (this.vertices.length < floats)
          this.vertices = new Float32Array(
            Math.min(MAX_FLOATS, Math.max(1024, 2 ** Math.ceil(Math.log2(floats)))),
          );
        if (this.slots.length < count)
          this.slots = new Float64Array(
            Math.min(MAX_VERTICES, Math.max(256, 2 ** Math.ceil(Math.log2(count)))),
          );
      } catch (error) {
        if (error instanceof RangeError)
          throw new D3d11TextureError('D3D11 vertex staging allocation failed', 0x8007000e | 0);
        throw error;
      }
    }
    const strip = this.topology === 3 || this.topology === 5,
      cut = this.indexFormat === 57 ? 0xffff : 0xffffffff;
    // Planar float4 attributes avoid WebGL's255-byte interleaved-stride limit.
    vertices?.readDraw(
      this.vertices,
      count,
      start,
      base,
      indices,
      indices && strip ? cut : -1,
      this.slots,
    );
    const resources = this.textures.acquireShaderResources(
      program.samples.map((s) => this.psResources[s.resource] ?? null),
      reflectedSamples,
    );
    try {
      const state = this.snapshot();
      if (!this.output.use(state)) return;
      this.bindVertices(program, count, floats);
      // Texture/target preparation may have selected decoder programs or VAOs.
      this.programs.uploadConstants(program, this.vsBuffers, this.psBuffers);
      this.programs.uploadOutputRanges(program, this.output.normalizedTargetMask);
      if (program.targetHeight) gl.uniform1f(program.targetHeight, this.output.targetHeight);
      for (let i = 0; i < program.samples.length; i++) {
        const sample = program.samples[i]!;
        gl.activeTexture(gl.TEXTURE0 + sample.unit);
        gl.bindTexture(gl.TEXTURE_2D, resources.images[i]!);
        this.samplers.bind(sample.unit, this.psSamplers[sample.sampler] ?? null);
      }
      let emitted = false;
      if (indices && strip) {
        let first = 0;
        for (let i = 0; i <= count; i++)
          if (i === count || indices.read((start + i) >>> 0) === cut) {
            if (i > first) {
              gl.drawArrays(mode, first, i - first);
              emitted = true;
            }
            first = i + 1;
          }
      } else {
        gl.drawArrays(mode, 0, count);
        emitted = true;
      }
      if (emitted) {
        // Preserve asynchronous GPU submission across adjacent native draws.
        // Flush and shared-image publication check the submitted batch.
        this.pendingDraw = true;
        this.output.written(state);
      }
    } finally {
      resources.release();
    }
  }

  private bindVertices(program: D3d11LinkedProgram, count: number, floats: number): void {
    const gl = this.gl;
    if (!this.vertexArray) this.vertexArray = gl.createVertexArray();
    if (!this.vertexArray)
      throw new D3d11TextureError('D3D11 vertex array allocation failed', 0x8007000e | 0);
    gl.bindVertexArray(this.vertexArray);
    if (floats) {
      if (!this.vertexBuffer) this.vertexBuffer = gl.createBuffer();
      if (!this.vertexBuffer)
        throw new D3d11TextureError('D3D11 vertex buffer allocation failed', 0x8007000e | 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, floats), gl.STREAM_DRAW);
    }
    // Attribute enables and pointers are state of this private vertex array.
    for (const a of program.attributes) {
      const offset = a.location * count * 16;
      if (a.location >= this.enabledAttributes) gl.enableVertexAttribArray(a.location);
      if (this.attributeOffsets[a.location] !== offset) {
        gl.vertexAttribPointer(a.location, 4, gl.FLOAT, false, 0, offset);
        this.attributeOffsets[a.location] = offset;
      }
    }
    for (let i = program.attributes.length; i < this.enabledAttributes; i++)
      gl.disableVertexAttribArray(i);
    this.enabledAttributes = program.attributes.length;
  }

  private snapshot(): D3d11DrawOutputState {
    const s = this.outputState;
    s.depthTarget = this.depthTarget;
    s.blend = this.blendState?.description ?? null;
    s.blendFactor = this.blendFactor;
    s.sampleMask = this.sampleMask;
    s.depth = this.depthState?.description ?? null;
    s.stencilRef = this.stencilRef;
    s.raster = this.rasterState?.description ?? null;
    s.viewports = this.viewports;
    s.scissors = this.scissorRects;
    return s;
  }
}
