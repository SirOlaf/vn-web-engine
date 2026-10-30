import type {EmoteX64Model} from '../../formats/kirikiri/emote-model.js';
import type {ID3D11DepthStencilView, ID3D11RenderTargetView} from '../d3d11/contract.js';
import type {
  EmoteD3d11InitParam,
  EmoteD3d11Matrix,
  IEmoteD3d11Device,
  IEmoteD3d11Player,
} from './contract.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {PEmoteD3d11Player, type EmoteD3d11PlayerResources} from './player-d3d11.js';
import {emoteScalarClipFactory, type EmoteMotionClip} from './runtime/clip.js';
import {createEmoteControls} from './runtime/controls/index.js';
import {EmoteXorshift128} from './runtime/controls/random.js';
import type {EmoteClipFactory, EmoteX64MeshKernel} from './runtime/interfaces.js';
import {EmotePlayerCore} from './runtime/player-core.js';
import {EmoteModelCache} from './runtime/model-cache.js';
import {EmoteD3d11Matrices} from './runtime/render/d3d11-matrices.js';
import {EmoteD3d11MaskState} from './runtime/render/d3d11-mask-state.js';
import {EmoteD3d11Screen} from './runtime/render/d3d11-screen.js';
import {EmoteD3d11Shaders} from './runtime/render/d3d11-shaders.js';
import {EmoteD3d11Target} from './runtime/render/d3d11-target.js';
import {EmoteD3d11Textures} from './runtime/render/d3d11-textures.js';
import {EmoteD3d11MaskPool, EmoteD3d11Renderer} from './runtime/render/renderer-d3d11.js';
import type {EmoteX64ShaderBlobs} from './runtime/render/shaders.js';

/** Resource+renderer+file references retained by each PEmotePlayer, including clones. */
class PlayerResources implements EmoteD3d11PlayerResources {
  smoothing = true;
  private references = 0;
  private state: {
    readonly files: readonly Uint8Array[];
    readonly models: readonly EmoteX64Model[];
    readonly createClip: EmoteClipFactory;
    readonly random: EmoteXorshift128;
    readonly renderer: EmoteD3d11Renderer;
  } | null;

  constructor(
    readonly device: PEmoteD3d11Device,
    files: readonly Uint8Array[],
    models: readonly EmoteX64Model[],
    random: EmoteXorshift128,
    renderer: EmoteD3d11Renderer,
    kernel: EmoteX64MeshKernel,
  ) {
    this.state = {
      files,
      models,
      random,
      renderer,
      createClip: emoteScalarClipFactory(models, {kernel}),
    };
  }

  retain(): void {
    if (!this.state) throw new Error('Using released E-mote player resources');
    this.references++;
  }

  release(): void {
    if (!this.state || this.references === 0) throw new Error('Unbalanced E-mote resource release');
    if (--this.references !== 0) return;
    const {renderer} = this.state;
    this.state = null;
    renderer.dispose();
  }

  createCore(): EmotePlayerCore {
    const state = this.state;
    if (!state) throw new Error('Using released E-mote player resources');
    return new EmotePlayerCore({
      model: state.models[state.models.length - 1]!,
      driverSha256: EMOTEDRIVER_X64_SHA256,
      createClip: state.createClip,
      createControls: createEmoteControls,
      random: () => state.random.next(),
    });
  }

  draw(core: EmotePlayerCore): void {
    if (!this.state) throw new Error('Using released E-mote player resources');
    this.device.drawPlayer(this.state.renderer, core, this.smoothing);
  }
}

/** Exact x64 PEmoteDevice (0x180001530), using only the native D3D11 contracts. */
export class PEmoteD3d11Device implements IEmoteD3d11Device {
  private readonly param: EmoteD3d11InitParam;
  private references = 1;
  private shaders: EmoteD3d11Shaders | null = null;
  private textures: EmoteD3d11Textures | null = null;
  private masks: EmoteD3d11MaskPool | null = new EmoteD3d11MaskPool();
  private target: EmoteD3d11Target | null = null;
  private readonly screen = new EmoteD3d11Screen();
  private readonly matrices = new EmoteD3d11Matrices();
  private readonly models = new EmoteModelCache();

  constructor(
    param: EmoteD3d11InitParam,
    blobs: EmoteX64ShaderBlobs,
    private readonly kernel: EmoteX64MeshKernel,
    private readonly maskState = new EmoteD3d11MaskState(),
  ) {
    maskState.retain();
    this.param = {device: param.device, context: param.context};
    param.device.addRef();
    param.context.addRef();
    try {
      this.shaders = new EmoteD3d11Shaders(param.device, blobs);
      this.textures = new EmoteD3d11Textures(param.device);
    } catch (error) {
      this.references = 0;
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'E-mote device construction and cleanup failed');
      }
      throw error;
    }
  }

  private live(): void {
    if (this.references <= 0) throw new Error('Using a released E-mote device');
  }

  addRef(): number {
    this.live();
    return ++this.references;
  }
  release(): number {
    this.live();
    const count = --this.references;
    if (count === 0) this.dispose();
    return count;
  }
  refCount(): number {
    return this.references;
  }
  setMaskMode(mode: number): void {
    this.live();
    this.maskState.mode = mode | 0;
  }
  getMaskMode(): number {
    this.live();
    return this.maskState.mode;
  }

  /** 0x1800018c0 -> 0x180002130; each new resource seeds its own RNG at0x180006110. */
  createPlayers(files: readonly Uint8Array[]): IEmoteD3d11Player | null {
    this.live();
    if (files.length === 0) return null;
    const images = [...files],
      random = new EmoteXorshift128(),
      renderer = new EmoteD3d11Renderer(
        this.param.device,
        this.param.context,
        this.shaders!,
        this.textures!,
        this.masks,
      );
    try {
      const models = images.map((image) => {
        const model = this.models.read(image);
        renderer.loadModelSources(model);
        return model;
      });
      return new PEmoteD3d11Player(
        new PlayerResources(this, images, models, random, renderer, this.kernel),
      );
    } catch (error) {
      try {
        renderer.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'E-mote player construction and cleanup failed');
      }
      throw error;
    }
  }

  createPlayer(data: Uint8Array): IEmoteD3d11Player | null {
    return this.createPlayers([data]);
  }

  setRenderTarget(color: ID3D11RenderTargetView, depth: ID3D11DepthStencilView | null): void {
    this.live();
    const target = new EmoteD3d11Target(color, depth),
      old = this.target;
    this.target = target;
    old?.dispose();
  }
  setScreenRect(x: number, y: number, width: number, height: number, mode: number): void {
    this.live();
    this.screen.setScreenRect(x, y, width, height, mode);
  }
  setAutomaticMatrix(enabled: boolean): void {
    this.live();
    this.matrices.setAutomaticMatrix(enabled);
  }
  getAutomaticMatrix(): boolean {
    this.live();
    return this.matrices.getAutomaticMatrix();
  }
  setWorldMatrix(matrix: EmoteD3d11Matrix): void {
    this.live();
    this.matrices.setWorldMatrix(matrix);
  }
  setViewMatrix(matrix: EmoteD3d11Matrix): void {
    this.live();
    this.matrices.setViewMatrix(matrix);
  }
  setProjectionMatrix(matrix: EmoteD3d11Matrix): void {
    this.live();
    this.matrices.setProjectionMatrix(matrix);
  }

  /** Private device/renderer composition; no clip or callback crosses the DLL contract. */
  drawPlayer(renderer: EmoteD3d11Renderer, core: EmotePlayerCore, smoothing: boolean): void {
    this.live();
    if (!this.target) throw new Error('E-mote render target has not been installed');
    const target = this.target.binding;
    this.screen.prepare(target.width, target.height, this.matrices.getAutomaticMatrix());
    renderer.render(
      (core.renderClip as EmoteMotionClip).drawList,
      target,
      this.matrices.shaderMatrix(target.width, target.height, this.screen.mode),
      smoothing,
      this.maskState.mode,
    );
  }

  private dispose(): void {
    this.models.clear();
    const errors: unknown[] = [];
    for (const object of [this.target, this.masks, this.textures, this.shaders])
      try {
        object?.dispose();
      } catch (error) {
        errors.push(error);
      }
    this.target = this.masks = this.textures = this.shaders = null;
    for (const object of [this.param.context, this.param.device])
      try {
        object.release();
      } catch (error) {
        errors.push(error);
      }
    this.maskState.release();
    if (errors.length) throw new AggregateError(errors, 'E-mote device retirement failed');
  }
}
