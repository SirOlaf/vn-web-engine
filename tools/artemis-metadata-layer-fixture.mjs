/** Read-only geometry fixture for control-flow probing. It decodes only transition rule
 * images into native gray bytes and video layers through the native CTheora model, both
 * reported as hashes and counters; it never prepares GPU resources, displays game media
 * or claims production rendering.
 */
import {createHash} from 'node:crypto';
import {ArtemisImageLoader, artemisPngSurfaceFormat} from '../dist/engines/artemis/image-loader.js';
import {ArtemisLayerOwner} from '../dist/engines/artemis/layer-owner.js';
import {ArtemisDisplayObject} from '../dist/engines/artemis/display-object.js';
import {ArtemisShaderProperties} from '../dist/engines/artemis/shader-properties.js';
import {artemisLayerExtent} from '../dist/engines/artemis/layer-info.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {readJpegHeader} from '../dist/formats/jpeg/header.js';
import {decodePng} from '../dist/formats/png/decode.js';
import {artemisPngDecodeOptions, artemisPngSurface} from '../dist/engines/artemis/png-surface.js';

/** `runMode` supplies the probe's run mode/wait owner for trans and sync tweens, `emit`
 * for tween completion events and `stageSize` for rule transitions; an absent owner
 * refuses them. */
// `reportFailures`: missing images and layers are recorded like the native script error
// reports (the game continues) instead of stopping the probe.
// `failureContext` adds diagnostic fields (e.g. the probe's tag index) to each failure.
export function createMetadataLayerFixture(
  hash,
  readFile,
  runMode = null,
  reportFailures = false,
  failureContext = () => ({}),
) {
  artemisRevision(hash);
  const failures = [];
  const loads = [],
    effects = [],
    actors = new Set(),
    // Video decoders shared by actor copies, with their reference counts.
    videos = new Map();
  let sequence = 0,
    tweenFrames = 0;
  const dimensions = (width, height) => {
    if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 0x7fffffff))
      throw Error('Invalid probe image metadata dimensions');
    return {width, height};
  };
  const imageSource = new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return null;
        if (bytes.length < 33) throw Error('Truncated probe PNG header');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
          throw Error('Invalid probe PNG IHDR');
        return {...dimensions(view.getUint32(16), view.getUint32(20)), colorType: bytes[25]};
      },
      surfaceFormat: (image) => artemisPngSurfaceFormat(image),
    },
    {
      extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'],
      decode: async (bytes) => {
        if (bytes[0] !== 255 || bytes[1] !== 216) return null;
        const header = readJpegHeader(bytes);
        return dimensions(header.width, header.height);
      },
    },
    {
      extensions: ['psd', 'PSD'],
      decode: async (bytes) => {
        if (![56, 66, 80, 83].every((v, i) => bytes[i] === v)) return null;
        if (bytes.length < 26) throw Error('Truncated probe PSD header');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return dimensions(view.getUint32(18), view.getUint32(14));
      },
    },
  ]);
  const source = {
    async load(name) {
      const resource = await imageSource.load(name);
      loads.push({
        name,
        path: resource?.path ?? null,
        width: resource?.image.width ?? null,
        height: resource?.image.height ?? null,
        pixelDecode: false,
      });
      return resource;
    },
  };
  const graphics = (registry) => ({
    creationMode: () => 0,
    createImageLayer(resource, anchor) {
      const display = new ArtemisDisplayObject(hash);
      display.apply({anchorx: anchor.x, anchory: anchor.y});
      const actor = {
        id: ++sequence,
        kind: 'image',
        path: resource.path,
        width: resource.image.width,
        height: resource.image.height,
        format: resource.surfaceFormat,
        display,
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    // Node mask setter 0x1400b29c0: an empty group keeps the mask on its node (shared by
    // holder copies); an image forwards it to its inner actors, which keep only a format 0
    // mask of their own dimensions on a format 1 or 2 image (0x1400a4490).
    applyLayerMask(list, group, resource) {
      for (const actor of list) if (!actors.has(actor)) throw Error('Probe actor released');
      const mask = resource && {
        width: resource.image.width,
        height: resource.image.height,
        format: resource.surfaceFormat ?? null,
      };
      let accepted = 0;
      if (group) {
        list[0].wrapper.mask = mask;
        accepted = 1;
      } else
        for (const actor of list) {
          if (actor.kind !== 'image') throw Error('Unsupported Artemis layer mask actor');
          if (mask) {
            if (actor.format === undefined)
              throw Error('Unsupported Artemis layer mask target surface format');
            if (actor.format !== 1 && actor.format !== 2) continue;
            if (mask.format === null) throw Error('Unsupported Artemis layer mask surface format');
            if (mask.format !== 0 || mask.width !== actor.width || mask.height !== actor.height)
              continue;
          }
          actor.mask = mask;
          accepted++;
        }
      effects.push({
        kind: 'layerMask',
        group,
        actors: list.length,
        accepted,
        width: mask?.width ?? null,
        height: mask?.height ?? null,
        format: mask?.format ?? null,
        simulation: true,
      });
    },
    createGroupLayer() {
      const actor = {
        id: ++sequence,
        kind: 'group',
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    // CAnimationLayer with the shared frame map; frames are ordinary image actors.
    createAnimationLayer(animation) {
      const actor = {
        id: ++sequence,
        kind: 'animation',
        animation,
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      return actor;
    },
    animationFrames: (actor) => actor.animation,
    readVideoFile: async (path) => {
      const bytes = await readFile(path);
      loads.push({name: path, kind: 'video', bytes: bytes?.length ?? null});
      return bytes;
    },
    createVideoLayer(video, anchor) {
      const display = new ArtemisDisplayObject(hash);
      display.apply({anchorx: anchor.x, anchory: anchor.y});
      const actor = {
        id: ++sequence,
        kind: 'video',
        video,
        width: video.width,
        height: video.height,
        display,
        wrapper: {alpha: 1},
        properties: {},
      };
      videos.set(video, 1);
      actors.add(actor);
      effects.push({kind: 'video', width: video.width, height: video.height, mask: video.hasMask});
      return actor;
    },
    createEmoteLayer(emote) {
      const actor = {
        id: ++sequence,
        kind: 'emote',
        emote,
        width: emote.width,
        height: emote.height,
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      actors.add(actor);
      effects.push({kind: 'emote', width: emote.width, height: emote.height});
      return actor;
    },
    videoError: (tag, error) => {
      throw Error(`Probe video ${error}: ` + tag.args.get('file'));
    },
    animationError: (tag, error) => {
      throw Error(`Probe animation ${error}: ` + tag.args.get('id'));
    },
    appendLayerCommand: (id, tag) => {
      effects.push({kind: 'appendCommand', id, name: tag.name});
      registry.appendLayerCommand(id, tag);
    },
    copyImageLayer(old) {
      if (!actors.has(old)) throw Error('Probe actor released');
      // A CEmoteLayer copy clones its player (0x14001a4f0), which is not modeled.
      if (old.kind === 'emote') throw Error('Unsupported Artemis E-mote layer copy');
      const actor = {
        ...old,
        id: ++sequence,
        animation: old.animation?.copy(),
        display: old.display.copy(),
        properties: {...old.properties},
        shader: old.shader?.copy(),
      };
      if (actor.kind === 'message') actor.messageOwner.retain(actor.message);
      if (actor.video) videos.set(actor.video, videos.get(actor.video) + 1);
      actors.add(actor);
      return actor;
    },
    applyImageProperties(id, actor, patch) {
      actor.display.apply(patch);
      if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
      Object.assign(actor.properties, patch);
      effects.push({kind: 'properties', id, keys: Object.keys(patch), simulation: true});
    },
    // Shader state is recorded through the shared property owner; no program is compiled.
    supportsShaderProperties: () => true,
    createShaderTexture(resource) {
      let references = 1;
      const texture = Object.freeze({path: resource.path, width: resource.image.width});
      const lease = {
        resource: texture,
        retain() {
          if (!references) throw Error('Probe shader texture released');
          references++;
          return lease;
        },
        release() {
          if (!references) throw Error('Probe shader texture released twice');
          references--;
        },
      };
      return lease;
    },
    applyShaderProperties(actor, patch, textures) {
      if (!actors.has(actor)) throw Error('Probe actor released');
      if (patch.textures !== undefined && textures === undefined)
        throw Error('Artemis shader textures require prepared resource leases');
      actor.shader ??= new ArtemisShaderProperties(hash);
      if (patch.shader !== undefined) actor.shader.setShader(patch.shader);
      if (patch.constants !== undefined) actor.shader.setConstants(patch.constants);
      if (textures !== undefined) actor.shader.setTextures(textures);
      effects.push({kind: 'shader', keys: Object.keys(patch), simulation: true});
    },
    releaseImageLayer(actor) {
      if (!actors.delete(actor)) throw Error('Probe actor released twice');
      actor.shader?.close();
      actor.animation?.close();
      if (actor.kind === 'message') actor.messageOwner.release(actor.message);
      if (actor.video) {
        const references = videos.get(actor.video) - 1;
        if (references) videos.set(actor.video, references);
        else {
          videos.delete(actor.video);
          actor.video.close();
        }
      }
      effects.push({kind: 'release', actor: actor.id});
    },
    clearLayerCommands: (ids) => {
      effects.push({kind: 'clearCommands', ids});
      registry.clearLayerCommands(ids);
    },
    resetLayerCommands: (id, tag) => {
      effects.push({kind: 'resetCommands', id});
      registry.resetLayerCommands(id, tag);
    },
    // lyprop (and lytween's synthesized end state) outside replay: coalescing record b9cd0.
    recordLayerProperties: (tag) => {
      effects.push({kind: 'recordProperties', id: tag.args.get('id')});
      registry.recordLayerProperties(tag);
    },
    imageLoadFailed: (tag) => {
      if (!reportFailures) throw Error('Probe image metadata missing: ' + tag.args.get('file'));
      failures.push({
        kind: 'image',
        tag: tag.name,
        file: tag.args.get('file') ?? null,
        ...failureContext(),
      });
    },
    layerNotFound: (tag) => {
      if (!reportFailures) throw Error('Probe layer missing: ' + tag.args.get('id'));
      failures.push({
        kind: 'layer',
        tag: tag.name,
        id: tag.args.get('id') ?? null,
        ...failureContext(),
      });
    },
  });
  // Rule images use the stage loader; only PNG has a decoded native surface here.
  const ruleSource = new ArtemisImageLoader(readFile, [
    {
      extensions: ['png', 'PNG'],
      decode: async (bytes) => {
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return null;
        return artemisPngSurface(await decodePng(bytes, artemisPngDecodeOptions));
      },
    },
    ...[
      ['jpg', 'jpeg', 'JPG', 'JPEG'],
      ['psd', 'PSD'],
    ].map((extensions) => ({
      extensions,
      decode: async () => {
        throw Error(`Unsupported diagnostic Artemis ${extensions[0]} rule image`);
      },
    })),
  ]);
  const refuseRunMode = () => {
    throw Error('Unsupported diagnostic Artemis trans run mode owner');
  };
  const owner = new ArtemisLayerOwner(hash, {
    createGraphics: graphics,
    images: source,
    runMode: {
      enter: (mode) => (runMode?.enter ?? refuseRunMode)(mode),
      release: () => (runMode?.release ?? refuseRunMode)(),
      now: () => runMode?.now() ?? refuseRunMode(),
      setWaitStart: (ms) => (runMode?.setWaitStart ?? refuseRunMode)(ms),
      emit: (tag) => {
        if (!runMode?.emit) throw Error('Unsupported diagnostic Artemis tween event owner');
        runMode.emit(tag);
      },
      stageSize: () => {
        if (!runMode?.stageSize) throw Error('Unsupported diagnostic Artemis rule transition');
        return runMode.stageSize();
      },
      skipState: () => runMode?.skipState() ?? refuseRunMode(),
      reportTagError: (tag, message) => {
        if (!runMode?.reportTagError) throw Error('Unsupported Artemis trans error report');
        runMode.reportTagError(tag, message);
      },
    },
    loadRule: async (path) => {
      const resource = await ruleSource.load(path);
      const image = resource?.image ?? null;
      effects.push({
        kind: 'ruleLoad',
        path: resource?.path ?? null,
        format: image?.format ?? null,
        width: image?.width ?? null,
        height: image?.height ?? null,
        sha256: image ? createHash('sha256').update(image.pixels).digest('hex') : null,
      });
      return image;
    },
    createMessageActor: (message, messageOwner) => {
      const actor = {
        id: ++sequence,
        kind: 'message',
        message,
        messageOwner,
        display: new ArtemisDisplayObject(hash),
        wrapper: {alpha: 1},
        properties: {},
      };
      messageOwner.retain(message);
      actors.add(actor);
      return actor;
    },
    // Per-frame values update the actor geometry without one effect record per frame.
    applyTweenProperties(id, actor, patch) {
      actor.display.apply(patch);
      Object.assign(actor.properties, patch);
      tweenFrames++;
    },
    videoOf: (actor) => actor.video,
    emoteOf: (actor) => actor.emote,
    // CLayer getters over the recorded properties; an empty group reads as a CLayer
    // without a surface. Animation and message actors read other native getters.
    layerInfo(actor) {
      if (!['image', 'video', 'emote', 'group'].includes(actor.kind))
        throw Error('Unsupported Artemis layer info actor');
      const props = actor.properties,
        surface = actor.kind === 'group' ? null : {width: actor.width, height: actor.height};
      const clip = props.clip ?? {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
      return {
        display: actor.display,
        ...artemisLayerExtent(surface, clip),
        surface,
        clip,
        layerMode: props.layermode ?? 'normal',
        negative: props.negative ?? false,
        grayscale: props.grayscale ?? false,
        colorMultiply: props.colormultiply ?? 0xffffff,
        shader: actor.shader?.shaderName ?? '',
        shaderConstants: actor.shader?.constantValues() ?? [],
      };
    },
    trace: (effect) => effects.push(effect),
  });
  const layers = owner.layers,
    layerCommands = owner.commands;
  return {
    /** Steps every registered layer tween and updates every video at the probe clock; the
     * fixture's draw (the E-mote layers' player advance) follows. */
    tickTweens: (now) => {
      owner.tickTweens(now);
      owner.drawEmoteLayers(now);
    },
    createEmoteLayer: (id, emote) => owner.createEmoteLayer(id, emote),
    emoteLayer: (id) => owner.emoteLayer(id),
    /** wait video= frame check: layer `id` is a video layer that is still playing. */
    videoPlaying: (id) => owner.videoPlaying(id),
    get tweenSyncPending() {
      return owner.tweenSyncPending;
    },
    get tweensRegistered() {
      return owner.tweenRegistry.size;
    },
    /** The global tween registry shared with text display tweens. */
    tweenRegistry: owner.tweenRegistry,
    dispatchTween: (tag, recordHistory) => owner.dispatchTween(tag, recordHistory),
    hasLayer: (id) => owner.hasLayer(id),
    layerInfo: (id) => owner.layerInfo(id),
    /** Runs the registered transition tween from `start` (nonzero uint32) to natural
     * completion and returns the completion tick. */
    finishTransition: (start) => owner.finishTransition(start),
    tickTransition: (now) => owner.tickTransition(now),
    get transitionPending() {
      return owner.transitionPending;
    },
    attachMessageActor: (name, message, messageOwner) =>
      owner.attachMessageActor(name, message, messageOwner),
    detachMessageActor: (name) => owner.detachMessageActor(name),
    reset: () => owner.reset(),
    /** Save-object reset of the layer command registry. */
    clearLayerCommands: () => owner.clearLayerCommands(),
    /** Save-object +0x68 layer command registry for the scenario save and load. */
    snapshotLayerCommands: () => owner.snapshotLayerCommands(),
    restoreLayerCommands: (snapshot) => owner.restoreLayerCommands(snapshot),
    /** Diagnostic choice discovery, not native hit testing. */
    clickableLayers: () => owner.clickableLayers(),
    setDraggable: (id, draggable) => owner.setDraggable(id, draggable),
    updatePointer: (pointer, hits, keys) => owner.updatePointer(pointer, hits, keys),
    /** Invokes an actor's stored layer event callback; no pointer hit testing is simulated. */
    invokeLayerEvent: (id, type, sink) => owner.invokeLayerEvent(id, type, sink),
    dispatchTransition: (tag) => owner.dispatchTransition(tag),
    accepts: (tag) => owner.accepts(tag),
    dispatch: (tag, recordHistory = true) => owner.dispatch(tag, recordHistory),
    snapshot: () => ({
      mode: 'metadata-only fixture',
      pixelDecode: false,
      gpuPreparation: false,
      tweenFrames,
      presentation: false,
      loads,
      effects,
      layers: layers.scene.entries().map((entry) => ({
        id: entry.id,
        group: entry.acceptsChildren,
        path: entry.value?.path ?? null,
        width: entry.value?.width ?? null,
        height: entry.value?.height ?? null,
        properties: entry.value?.display.properties ?? null,
        mask: entry.value?.mask ?? entry.value?.wrapper.mask ?? null,
        // Frame map keys with frame paths; null marks the cycle end.
        animation: entry.value?.animation
          ? {
              ...entry.value.animation.state,
              frames: entry.value.animation
                .entries()
                .map(([time, frame]) => ({time, path: frame?.path ?? null})),
            }
          : null,
        shader: entry.value?.shader
          ? {
              name: entry.value.shader.shaderName,
              constants: entry.value.shader.constantValues(),
              textures: entry.value.shader.textureValues().map((texture) => ({
                name: texture.name,
                path: texture.resource.path,
              })),
            }
          : null,
        video: entry.value?.video
          ? {
              playing: entry.value.video.playing,
              mask: entry.value.video.hasMask,
              ...entry.value.video.frame,
              revision: entry.value.video.revision,
              pixelsSha256: createHash('sha256').update(entry.value.video.pixels).digest('hex'),
            }
          : null,
        emote: entry.value?.emote
          ? {
              progress: entry.value.emote.progress,
              hidden: entry.value.emote.player.isHidden(),
              playing: entry.value.emote.player.countPlayingTimelines(),
              animating: entry.value.emote.player.isAnimating(),
            }
          : null,
        events: entry.value
          ? ['click', 'rollover', 'rollout', 'dragin', 'drag', 'dragout'].filter((type) =>
              owner.eventSlots(entry.value).callback(type),
            )
          : [],
      })),
      layerCommands: [...layerCommands.snapshot()].map(([id, tags]) => ({
        id,
        commands: tags.map((tag) => Object.fromEntries(tag.args)),
      })),
      failures,
    }),
    close: () => owner.close(),
  };
}
