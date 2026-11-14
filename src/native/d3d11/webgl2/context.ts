import type {ID3D11DeviceContext} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {sm4VertexRegisters} from '../../../graphics/d3d11-shader/program.js';
import {
  D3d11IndexReader,
  D3d11VertexReader,
  type D3d11GpuStreams,
} from '../runtime/input-assembly.js';
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
/** GL POINTS, LINES, LINE_STRIP, TRIANGLES, TRIANGLE_STRIP for D3D11 topologies 1–5. */
const DRAW_MODES: readonly number[] = [0x0000, 0x0001, 0x0003, 0x0004, 0x0005];
/** Native draws recorded before the batch is submitted; the GPU then starts while the CPU
 * still records instead of waiting for the next readback. */
const SUBMIT_DRAWS = 8;

export class D3d11DrawContext extends D3d11TransferContext implements ID3D11DeviceContext {
  private vertices = new Float32Array(0);
  /** Per-slot vertex scratch of the staged draw. */
  private slots = new Float64Array(0);
  /** Per-draw shader resource view scratch; textures only read it during acquisition. */
  private readonly sampleViews = this.psResources.slice(0, 0);
  private vertexArray: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private enabledAttributes = 0;
  /** Vertex array pointer offsets by location; the array never sets a divisor. */
  private readonly attributeOffsets: number[] = [];
  /** Vertex array, window buffers and pointer keys by location of native streams. */
  private streamArray: WebGLVertexArrayObject | null = null;
  private readonly streamBuffers: WebGLBuffer[] = [];
  private streamAttributes = 0;
  private readonly streamPointers: string[] = [];
  private gpuDisposed = false;
  private pendingDraw = false;
  private unsubmittedDraws = 0;
  private readonly outputState: Mutable<D3d11DrawOutputState>;

  constructor(
    private readonly drawOwner: D3d11DeviceOwner,
    gl: WebGL2RenderingContext,
    textures: D3d11GpuTextures,
    private readonly output: D3d11GpuOutput,
    private readonly programs: D3d11ProgramCache,
    private readonly samplers: D3d11GpuSamplers,
    /** 0 leaves submission to the next synchronous call or the end of the browser task. */
    private readonly submitDraws = SUBMIT_DRAWS,
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
      () => this.streamArray && this.gl.deleteVertexArray(this.streamArray),
      ...this.streamBuffers.map((buffer) => () => this.gl.deleteBuffer(buffer)),
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
    this.streamArray = null;
    this.streamBuffers.length = 0;
    this.streamAttributes = 0;
    this.streamPointers.length = 0;
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
      mode = DRAW_MODES[this.topology - 1];
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
      if (this.renderTargets[i]?.resource.format === 65) alphaTargets |= 1 << i;
    const samples = this.pixelShader.shader.code.samples;
    for (let i = 0; i < samples.length; i++) {
      const view = this.psResources[samples[i]!.resource],
        sampler = this.psSamplers[samples[i]!.sampler]?.description;
      if (view?.resource.format === 65) alphaSamples |= 1 << i;
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
    const registers = sm4VertexRegisters(this.vertexShader.shader),
      floats = count * registers.length * 4;
    if (count > MAX_VERTICES || floats > MAX_FLOATS)
      throw new D3d11TextureError('D3D11 draw exceeds bounded vertex staging', 0x8007000e | 0);
    let vertices: D3d11VertexReader | null = null,
      streams: D3d11GpuStreams | null = null;
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
      // Non-indexed in-bounds draws fetch the native bytes on the GPU.
      if (!indices) streams = vertices.gpuStreams(count, start, base);
    }
    const program = this.programs.use(
      this.vertexShader,
      this.pixelShader,
      alphaTargets,
      alphaSamples,
      reflectedSamples,
      this.output.unclippedDepth(
        this.rasterState?.description ?? null,
        this.depthState?.description ?? null,
        this.depthTarget,
      ),
      streams?.unormRegisters ?? 0,
    );
    if (vertices && !streams) {
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
    if (!streams)
      vertices?.readDraw(
        this.vertices,
        count,
        start,
        base,
        indices,
        indices && strip ? cut : -1,
        this.slots,
      );
    const views = this.sampleViews;
    views.length = program.samples.length;
    for (let i = 0; i < views.length; i++)
      views[i] = this.psResources[program.samples[i]!.resource] ?? null;
    const resources = this.textures.acquireShaderResources(views, reflectedSamples);
    try {
      const state = this.snapshot();
      if (!this.output.use(state)) return;
      if (streams) this.bindStreams(program, streams);
      else this.bindVertices(program, count, floats);
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
        if (this.submitDraws && ++this.unsubmittedDraws >= this.submitDraws) {
          this.unsubmittedDraws = 0;
          gl.flush();
        }
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

  private bindStreams(program: D3d11LinkedProgram, streams: D3d11GpuStreams): void {
    const gl = this.gl;
    if (!this.streamArray) this.streamArray = gl.createVertexArray();
    if (!this.streamArray)
      throw new D3d11TextureError('D3D11 vertex array allocation failed', 0x8007000e | 0);
    gl.bindVertexArray(this.streamArray);
    for (let w = 0; w < streams.windows.length; w++) {
      let buffer = this.streamBuffers[w];
      if (!buffer) {
        const created = gl.createBuffer();
        if (!created)
          throw new D3d11TextureError('D3D11 vertex buffer allocation failed', 0x8007000e | 0);
        this.streamBuffers[w] = buffer = created;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, streams.windows[w]!, gl.STREAM_DRAW);
    }
    // Window buffers keep their identity, so unchanged pointers stay valid.
    for (const a of streams.attributes) {
      const key = `${a.window}:${a.format}:${a.stride}:${a.relative}`;
      if (a.location >= this.streamAttributes) gl.enableVertexAttribArray(a.location);
      if (this.streamPointers[a.location] === key) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.streamBuffers[a.window]!);
      if (a.format === 87)
        gl.vertexAttribIPointer(a.location, 4, gl.UNSIGNED_BYTE, a.stride, a.relative);
      else
        gl.vertexAttribPointer(
          a.location,
          a.format === 6 ? 3 : 2,
          gl.FLOAT,
          false,
          a.stride,
          a.relative,
        );
      this.streamPointers[a.location] = key;
    }
    for (let i = program.attributes.length; i < this.streamAttributes; i++)
      gl.disableVertexAttribArray(i);
    this.streamAttributes = program.attributes.length;
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
