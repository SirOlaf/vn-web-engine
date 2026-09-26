import {createGroup80InputWait, createGroup80Threads} from './group-80-threads.js';
import {createGroup80DataDecode} from './group-80-data-decode.js';
import {createGroup80Allocation} from './group-80-allocation.js';
import {createGroup80SdcDecode} from './group-80-sdc-decode.js';
import {createGroup80SdcEncode} from './group-80-sdc-encode.js';
import {createGroup80StructCodec} from './group-80-struct-codec.js';
import {createGroup80LocalTime, createGroup80Timing} from './group-80-timing.js';
import {createGroupC0Rain} from './group-c0-rain.js';
import {createGroupC0Bwef} from './group-c0-bwef.js';
import {createGroupB0FontNames, createGroupB0Fonts} from './group-b0-fonts.js';
import {createGroupB0InlineText, createGroupB0Shake} from './group-b0-main.js';
import {createBurikoBitmapLoadingSlots} from './group-bitmap-loading.js';
import {createGroup80GlobalMemory} from './group-80-global-memory.js';
import {createGroup80Launch} from './group-80-launch.js';
import {createGroup80Resources} from './group-80-resources.js';
import {createGroup81SharedThreads} from './group-81-shared-threads.js';
import {createGroup81ResourceServices} from './group-81-resource-services.js';
import {createGroup81InternetRead} from './group-81-internet-read.js';
import {createGroup81ShellShortcuts} from './group-81-shell-shortcuts.js';
import {createGroup90Groups} from './group-90-groups.js';
import {createGroup90Maps} from './group-90-maps.js';
import {createGroup90PerspectivePoint} from './group-90-perspective-point.js';
import {createGroup90TextProcessSettings} from './group-90-text-process-settings.js';
import {createGroup90TextDisplay} from './group-90-text-display.js';
import {createGroup91TextDisplay} from './group-91-text-display.js';
import {createGroup92TextDisplay} from './group-92-text-display.js';
import {createGroup91Landscapes} from './group-91-landscapes.js';
import {createGroup91PresentationSettings} from './group-91-presentation-settings.js';
import {createGroup91SurfaceMovies} from './group-91-surface-movies.js';
import {createGroup91MfMovies} from './group-91-mf-movies.js';
import {createGroup92SurfaceMovies} from './group-92-surface-movies.js';
import {createTraditionalMovieSlots} from './group-90-traditional-movies.js';
import {createGroup90Knobs, createGroup91KnobPointer} from './group-90-knobs.js';
import {createGroup90Filters} from './group-90-filters.js';
import {createGroup90Surfaces} from './group-90-surfaces.js';
import {createGroup90SurfaceCentered} from './group-90-surface-centered.js';
import {createGroup90SurfaceEffects} from './group-90-surface-effects.js';
import {createGroup90SurfaceMirrorReduce} from './group-90-surface-mirror-reduce.js';
import {createGroup90BackdropVector} from './group-90-backdrop-vector.js';
import {createGroup90BackdropBasic} from './group-90-backdrop-basic.js';
import {createGroup90BackdropPan} from './group-90-backdrop-pan.js';
import {createGroup90BackdropMask} from './group-90-backdrop-mask.js';
import {createGroup90BackdropDifference} from './group-90-backdrop-difference.js';
import {createGroup90BackdropMosaic} from './group-90-backdrop-mosaic.js';
import {createGroup90BackdropStretch} from './group-90-backdrop-stretch.js';
import {createGroup90BackdropRotation} from './group-90-backdrop-rotation.js';
import {createGroup90RippleBackdrop} from './group-90-backdrop-ripple.js';
import {createGroup90BackdropBlur} from './group-90-backdrop-blur.js';
import {createGroup90AspectFit} from './group-90-aspect-fit.js';
import {createGroup90BitmapCacheServices} from './group-90-bitmap-cache-services.js';
import {createGroup90CompressedEncode} from './group-90-compressed-encode.js';
import {createGroup90RawSurfaceExport} from './group-90-raw-surface-export.js';
import {createGroup90DiskImages} from './group-90-disk-images.js';
import {createGroup90ToneCurves} from './group-90-tone-curves.js';
import {createGroup90TransformedMesh} from './group-90-transformed-mesh.js';
import {createGroup90DisplayBase} from './group-90-display-base.js';
import {createGroup90DisplayControl} from './group-90-display-control.js';
import {createGroup90DisplayHit} from './group-90-display-hit.js';
import {createGroup90DisplayImmediate} from './group-90-display-immediate.js';
import {createGroup90DisplayShake} from './group-90-display-shake.js';
import {createGroup90CoordinateSplineControl} from './group-90-coordinate-spline-control.js';
import {createGroup90SpriteConfiguration} from './group-90-sprite-configuration.js';
import {createGroup90SpriteLifecycle} from './group-90-sprite-lifecycle.js';
import {createGroup90SpriteNotifications} from './group-90-sprite-notifications.js';
import {createGroup90SpriteTargets} from './group-90-sprite-targets.js';
import {createGroup90Windows} from './group-90-windows.js';
import {createGroup90WindowBitmapGroups} from './group-90-window-bitmap-groups.js';
import {createGroup90SelectionBitmaps} from './group-90-selection-bitmaps.js';
import {createGroup90SelectionBitmapProcess} from './group-90-selection-bitmap-process.js';
import {createGroup90SelectionProcess} from './group-90-selection-process.js';
import {createGroup90SelectionText} from './group-90-selection-text.js';
import {createGroup90SelectionExtended} from './group-90-selection-extended.js';
import {
  createGroup90ImmediateIconDescription,
  createGroup90IndependentIcons,
} from './group-90-independent-icons.js';
import {createGroup91IndependentIconEx} from './group-91-independent-icon-ex.js';
import {createGroup91IndependentIconMotion} from './group-91-independent-icon-motion.js';
import {BurikoIndependentIconState} from './independent-icon.js';
import {BurikoSelectionState} from './selection-state.js';
import {BurikoNativeSplines} from './spline-registry.js';
import {createGroup91BackdropLayers} from './group-91-backdrop-layers.js';
import {createGroup91BitmapRegistration} from './group-91-bitmap-registration.js';
import {createGroup91DisplacementMaps} from './group-91-displacement-maps.js';
import {createGroup91DisplacementGenerators} from './group-91-displacement-generators.js';
import {createGroup91AngularDisplacement} from './group-91-angular-displacement.js';
import {createGroup91Effectors} from './group-91-effectors.js';
import {createGroup91ObjectProperty} from './group-91-object-property.js';
import {createGroup91ObjectCoordinates} from './group-91-object-coordinates.js';
import {createGroup91RasterSettings} from './group-91-raster-settings.js';
import {createGroup91TranslatedDisplay} from './group-91-translated-display.js';
import {createGroup91SurfaceScale} from './group-91-surface-scale.js';
import {createGroup91SurfaceSplat} from './group-91-surface-splat.js';
import {createGroup91SurfaceTransform} from './group-91-surface-transform.js';
import {createGroup91SurfaceColorMaskCopy} from './group-91-surface-color-mask-copy.js';
import {createGroup91SpriteMask} from './group-91-sprite-mask.js';
import {createGroup91TextSettings} from './group-91-text-settings.js';
import {createGroup91TextMetrics} from './group-91-text-metrics.js';
import {createGroup91FontRasterSettings} from './group-91-font-raster-settings.js';
import {createGroup91TextTags} from './group-91-text-tags.js';
import {
  createCustomTextGlyphSettings,
  createHorizontalTextLayoutServices,
  createTextLayoutSettings,
} from './group-text-layout-settings.js';
import {createGroup91WindowState} from './group-91-window-state.js';
import {createGroup92CoefficientTables} from './group-92-coefficients.js';
import {createGroup92HaloMask} from './group-92-halo-mask.js';
import {createGroup92AlphaExtraction} from './group-92-alpha-extraction.js';
import {createGroup92ImmediateBmp} from './group-92-immediate-bmp.js';
import {createGroup92ObjectLifecycle} from './group-92-object-lifecycle.js';
import {createGroup92SurfacePixels} from './group-92-surface-pixels.js';
import {createGroup92SurfaceText} from './group-92-surface-text.js';
import {createGroup92MonochromeText} from './group-92-monochrome-text.js';
import {createGroup92FontTransform} from './group-92-font-transform.js';
import {createGroup92SurfaceMasks} from './group-92-surface-masks.js';
import {createGroup92VectorMaps} from './group-92-vector-maps.js';
import {createGroup92WindowImages} from './group-92-window-images.js';
import {createGroupA0StaticDuration} from './group-a0-static-duration.js';
import {createGroupA0StaticPlay} from './group-a0-static-play.js';
import {createGroup90BmvResources} from './group-90-bmv-resources.js';
import {createGroup90BmvFrame} from './group-90-bmv-frame.js';
import {createGroup92BmvResources} from './group-92-bmv-resources.js';
import {createGroupA0SoundProcesses} from './group-a0-sound-processes.js';
import {createGroupA0StreamLoad} from './group-a0-stream-load.js';
import {createGroupA0MusicLoad} from './group-a0-music-load.js';
import {createGroupA0PairedMusicLoad} from './group-a0-paired-music-load.js';
import {
  createGroup92RegisteredLinkFont,
  createGroup92TextResults,
} from './group-92-text-results.js';
import {createGroupE0Files} from './group-e0-files.js';
import {createGroupE0BitmapDescription} from './group-e0-bitmap-description.js';
import {createGroupE0Records} from './group-e0-records.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from './inventory.js';
import {BurikoProductionVmCore} from './production-vm-core.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Sprite lifecycle and the shared manager's Window destructor; other lifecycle slots stay separate. */
const boundSpriteLifecycle = new Set([0x50, 0x51, 0x54, 0x55, 0x81]);
/** The explicit pre-input frame prefix polls retained Sprite target state. */
const boundSpriteTargets = new Set([0xf8, 0xfa, 0xfb, 0xfc, 0xfd]);
/** Host font raster callbacks require an explicitly selected graph font provider. */
const boundSurfaceServices = new Set([
  0x07, 0x0b, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1e, 0x1f,
]);
/** Capture/render enter after device startup; font cache uses the selected host font. */
const boundDisplayBase = new Set([0x00, 0x01, 0x02, 0x03, 0x06, 0x08, 0x09, 0x0a, 0x0c, 0x0f]);
/** 90:45 requires a selected vector-map/display context; the graph owns the state-only pair. */
const boundBackdropState = new Set([0x45, 0x4c, 0x4d]);
/** 90:66 enters after startup establishes the screen-sized mask context. */
const boundFilterState = new Set([0x60, 0x61, 0x64, 0x65]);
/** Vector and displacement effectors enter after display bitmap startup. */
const boundEffectorState = new Set([0x60, 0x61, 0x64, 0x66, 0x68, 0x69]);
/** Window font selection uses the graph's selected font provider. */
const boundWindowState = new Set([0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e]);
/** 91:05 enters after startup establishes the display context. */
const boundTranslatedDisplay = new Set([0x06]);
/** Annotation collection uses text only; host font raster and layout settings remain separate. */
const boundTextSettings = new Set([0x94, 0x96]);
const boundTextMetrics = new Set([0x95]);
/** Text selection process and glyph drawing require a configured font; these setters do not. */
const boundSelectionSettings = new Set([0xa4, 0xa5, 0xa6]);

/** VM-dependent definitions layered over the graph/data catalog, below a complete bank. */
export class BurikoProductionVmFragments {
  constructor(readonly core: BurikoProductionVmCore) {
    if (!(core instanceof BurikoProductionVmCore))
      throw new TypeError('Buriko VM fragments require the actual production VM core');
  }

  nativeDefinitions(): BurikoNativeSlotDefinition[] {
    this.core.assertNativeAdmission();
    const {graph, data, scheduler, control} = this.core;
    if (
      this.core.procedureState !== data.procedureState ||
      this.core.worker !== graph.resource.worker ||
      this.core.memory !== data.memory ||
      data.graph !== graph ||
      this.core.fragments.data !== data ||
      this.core.fragments.graph !== graph ||
      this.core.fragments.scheduler !== scheduler ||
      this.core.fragments.installation !== this.core.installation ||
      this.core.launchSelection !== graph.launchSelection ||
      graph.launchSelection.files !== graph.resource.files ||
      graph.launchSelection.paths !== graph.resource.files.paths ||
      graph.launchSelection.resources !== graph.resource.resources ||
      graph.launchSelection.errors !== graph.resource.errors ||
      graph.launchSelection.text !== graph.text ||
      graph.manager.surfaces !== graph.surfaces ||
      graph.manager.displayState !== graph.display ||
      graph.frames.display !== graph.display ||
      graph.manager.environment.compositor !== graph.compositor ||
      graph.manager.environment.damage !== graph.damage ||
      graph.frames.manager !== graph.manager ||
      graph.frames.device !== graph.device ||
      graph.frames.clock !== graph.clock ||
      graph.frames.metrics.clock !== graph.clock ||
      graph.particles.random !== graph.particleRandom ||
      graph.particles.clock !== graph.clock ||
      graph.particles.processing !== graph.resource.processing ||
      graph.particles.processing.allocator !== graph.allocator ||
      graph.rain.manager !== graph.manager ||
      graph.rain.state !== graph.rainState ||
      graph.rain.random !== graph.particleRandom ||
      graph.rain.ticks !== graph.ticks ||
      graph.rainFrames.rain !== graph.rain ||
      graph.rainFrames.clock !== graph.clock ||
      graph.bitmapLoadState.input !== graph.input ||
      graph.bitmapLoadState.clock !== graph.clock ||
      graph.bitmapLoading.surfaces !== graph.surfaces ||
      graph.bitmapLoading.resources !== graph.resource.loading ||
      graph.bitmapLoading.policy !== graph.bitmapLoadState ||
      graph.bitmapRegistration.loading !== graph.resource.loading ||
      graph.bitmapRegistration.surfaces !== graph.surfaces ||
      graph.bitmapCacheServices.loading !== graph.bitmapLoading ||
      graph.bitmapCacheServices.registration !== graph.bitmapRegistration ||
      graph.resource.loading.resources !== graph.resource.resources ||
      graph.resource.worker.loading !== graph.resource.loading ||
      graph.resource.worker.audio !== graph.resource.audio ||
      graph.resource.worker.scripts !== graph.resource.scripts ||
      graph.resource.audio.loading !== graph.resource.loading ||
      graph.resource.audio.music !== graph.resource.music ||
      graph.resource.audio.staticResources !== graph.resource.statics ||
      graph.resource.music.resources !== graph.resource.resources ||
      graph.resource.music.streams !== graph.resource.streams ||
      graph.resource.streams.channels !== graph.resource.channels ||
      graph.resource.streams.cache !== graph.resource.archiveCache ||
      graph.resource.streams.files !== graph.resource.files ||
      graph.resource.archiveCache.channels !== graph.resource.channels ||
      graph.resource.archiveCache.files !== graph.resource.files ||
      graph.resource.statics.channels !== graph.resource.channels ||
      graph.resource.resources.files !== graph.resource.files ||
      graph.resource.resources.mainProcessing !== graph.resource.processing ||
      graph.resource.loading.ranges.resources !== graph.resource.resources ||
      graph.resource.loading.cache.text !== graph.text ||
      graph.resource.loading.preloaded.text !== graph.text ||
      graph.compressedSurfaceEncoder.surfaces !== graph.surfaces ||
      graph.compressedSurfaceEncoder.processing !== graph.resource.processing ||
      graph.compressedSurfaceEncoder.ticks !== graph.ticks ||
      graph.compressedSurfaceEncoder.raw.surfaces !== graph.surfaces ||
      graph.resource.processing.allocator !== graph.allocator ||
      graph.groups.manager !== graph.manager ||
      graph.maps.manager !== graph.manager ||
      graph.landscapes.manager !== graph.manager ||
      graph.landscapes.input !== graph.input ||
      graph.filterDisplays.manager !== graph.manager ||
      graph.windowState.manager !== graph.manager ||
      graph.receiver.waits !== graph.waits ||
      graph.receiver.notifications !== graph.notifications ||
      graph.controller.notifications !== graph.notifications ||
      data.procedures.manager !== graph.manager ||
      !(data.independentIcon instanceof BurikoIndependentIconState) ||
      !(data.textSelection instanceof BurikoSelectionState) ||
      !(data.splines instanceof BurikoNativeSplines) ||
      graph.cursorPolicy.manager !== graph.manager ||
      graph.cursorPolicy.input !== graph.input ||
      graph.cursorPolicy.clock !== graph.clock ||
      graph.cursorPolicy.physical !== graph.cursor ||
      graph.cursorMotion.input !== graph.input ||
      graph.cursorMotion.clock !== graph.clock ||
      graph.windowState.textLayout.surfaces !== graph.surfaces ||
      graph.windowState.textLayout.text !== graph.text ||
      graph.windowState.textLayout.annotations.text !== graph.text ||
      graph.windowState.textLayout.customGlyphs.surfaces !== graph.surfaces ||
      graph.surfaces.fonts !== graph.fonts ||
      graph.monochromeText.surfaces !== graph.surfaces ||
      graph.fontResources.fonts !== graph.fonts ||
      graph.fontResources.resources !== graph.resource.resources ||
      (graph.fontProvider !== null && graph.fonts.browser !== graph.fontProvider) ||
      graph.inline.host !== graph.host ||
      graph.inline.fonts !== graph.fonts ||
      graph.inline.dialogs !== graph.dialogs ||
      graph.inline.messages !== graph.messages ||
      graph.inline.keyboard !== graph.keyboard ||
      graph.surfaceEffects.surfaces !== graph.surfaces ||
      graph.surfaces.compositor !== graph.compositor ||
      graph.surfaces.allocator !== graph.allocator ||
      graph.fonts.text !== graph.text ||
      graph.spriteTargets.manager !== graph.manager ||
      graph.spriteTargets.input !== graph.input ||
      graph.knobs.manager !== graph.manager ||
      graph.knobs.input !== graph.input ||
      graph.knobs.notifications !== graph.notifications ||
      graph.receiver.knobs !== graph.knobs ||
      !graph.input.usesClock(graph.clock) ||
      graph.resource.errors.files !== graph.resource.files ||
      graph.resource.errors.files.text !== graph.text ||
      graph.resource.files.text !== graph.text ||
      graph.resource.errors.dialogs !== graph.dialogs ||
      graph.folders.text !== graph.text ||
      graph.folders.registry !== graph.registry ||
      graph.folders.roots !== graph.resource.resources.configuration ||
      (graph.shellShortcutHost === null && graph.shellShortcuts !== null) ||
      (graph.shellShortcutHost !== null &&
        (graph.shellShortcuts?.host !== graph.shellShortcutHost ||
          graph.shellShortcuts.files !== graph.resource.files ||
          graph.shellShortcuts.folders !== graph.folders)) ||
      graph.resource.files.specialFolders !== graph.folders ||
      (graph.internetReadHost === null && graph.internetReads !== null) ||
      (graph.internetReadHost !== null &&
        (graph.internetReads?.host !== graph.internetReadHost ||
          graph.internetReads.files !== graph.resource.files)) ||
      graph.bmvService.registry !== graph.bmvRegistry ||
      graph.bmvService.surfaces !== graph.surfaces ||
      graph.bmvService.ranges !== graph.resource.loading.ranges ||
      graph.bmvService.synchronous !== graph.resource.processing ||
      graph.bmvService.asynchronous !== graph.bmvAsyncProcessing ||
      graph.bmvPump.service !== graph.bmvService
    )
      throw new Error('Buriko VM fragments require the graph launch, display and error owners');
    const selectedFontProvider = graph.fontProvider !== null;
    const definitions = [
      ...this.core.fragments.nativeDefinitions(),
      ...createGroup80Threads(
        scheduler,
        graph.clock,
        control,
        data.procedureState,
        graph.waits,
        graph.diagnosticDialogs,
      ),
      ...createGroup80Resources(scheduler, control, graph.resource.resources),
      ...createGroup80GlobalMemory(graph.resource.errors),
      ...createGroup80Timing(
        graph.particleRandom,
        this.core.frameHistory,
        graph.clock,
        graph.frames.metrics.counter,
      ),
      ...(graph.readLocalTime === null ? [] : createGroup80LocalTime(graph.readLocalTime)),
      ...createGroupC0Rain(graph.rain, graph.manager.redraw, graph.resource.errors),
      ...createGroupC0Bwef(graph.resource.resources),
      ...createGroup80Allocation(data.allocations, graph.resource.errors),
      ...createGroup80Launch(this.core.launchSelection),
      ...createGroup80InputWait(scheduler, graph.clock, data.procedureState, graph.input),
      ...createGroup80SdcEncode(
        graph.codecWorkers,
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup80SdcDecode(),
      ...createGroup80DataDecode(
        graph.codecWorkers,
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup80StructCodec(
        graph.codecWorkers,
        graph.resource.loading,
        this.core.structCodecScratch,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup81SharedThreads(scheduler, control, graph.resource.errors),
      ...createGroup81ResourceServices(
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
        control,
      ),
      ...(graph.internetReads === null
        ? []
        : createGroup81InternetRead(
            graph.internetReads,
            graph.resource.loading,
            scheduler,
            data.procedureState,
            graph.clock,
            control,
          )),
      ...(graph.shellShortcuts === null ? [] : createGroup81ShellShortcuts(graph.shellShortcuts)),
      ...createGroup90Surfaces(graph.surfaces, graph.bitmapLoadState, graph.resource.errors).filter(
        ({secondary}) =>
          boundSurfaceServices.has(secondary) || (selectedFontProvider && secondary === 0x0d),
      ),
      ...createGroup90SurfaceCentered(graph.surfaces, graph.resource.errors),
      ...createGroup90SurfaceEffects(graph.surfaceEffects, graph.resource.errors),
      ...createGroup90SurfaceMirrorReduce(graph.surfaces, graph.resource.errors),
      ...createBurikoBitmapLoadingSlots(
        graph.bitmapLoading,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup90BackdropVector(graph.manager, graph.resource.errors).filter(({secondary}) =>
        boundBackdropState.has(secondary),
      ),
      ...createGroup90BackdropBasic(graph.manager, graph.resource.errors),
      ...createGroup90BackdropPan(graph.manager, graph.resource.errors),
      ...createGroup90BackdropMask(graph.manager, graph.resource.errors),
      ...createGroup90BackdropDifference(graph.manager, graph.resource.errors),
      ...createGroup90BackdropMosaic(graph.manager, graph.resource.errors),
      ...createGroup90BackdropStretch(graph.manager, graph.resource.errors),
      ...createGroup90BackdropRotation(graph.manager, graph.resource.errors),
      ...createGroup90RippleBackdrop(graph.manager, graph.resource.errors),
      ...createGroup90BackdropBlur(graph.manager, graph.resource.errors),
      ...createGroup90DisplayBase(
        graph.manager,
        graph.frames,
        graph.resource.loading,
        graph.windowState,
        graph.resource.errors,
      ).filter(
        ({secondary}) =>
          boundDisplayBase.has(secondary) ||
          (selectedFontProvider && secondary === 0x0e) ||
          (graph.displayReadyForScriptGeometry && (secondary === 0x04 || secondary === 0x05)),
      ),
      ...createGroup90DisplayImmediate(graph.manager, graph.resource.errors),
      ...createGroup90DisplayShake(
        graph.manager,
        scheduler,
        data.procedureState,
        graph.clock,
        graph.input,
        graph.resource.errors,
      ),
      ...createGroup90DisplayHit(graph.manager, graph.input, graph.resource.errors),
      ...createGroup90AspectFit(graph.surfaces, graph.resource.errors),
      ...createGroup90BitmapCacheServices(graph.bitmapCacheServices),
      ...createGroup90RawSurfaceExport(graph.compressedSurfaceEncoder.raw, graph.resource.errors),
      ...createGroup90DiskImages(graph.diskImageService, graph.resource.errors),
      ...createGroup90CompressedEncode(graph.compressedSurfaceEncoder, graph.resource.errors),
      ...createGroup90ToneCurves(graph.surfaces, graph.resource.errors),
      ...createGroup90TransformedMesh(graph.surfaces, graph.resource.errors),
      ...createGroup90DisplayControl(
        graph.manager,
        scheduler,
        data.procedureState,
        graph.clock,
        graph.input,
        graph.resource.errors,
      ),
      ...createGroup90CoordinateSplineControl(
        graph.manager,
        scheduler,
        data.procedureState,
        graph.clock,
        graph.input,
        graph.resource.errors,
      ),
      ...createGroup90SpriteLifecycle(
        graph.manager,
        graph.spriteTargets,
        graph.resource.errors,
      ).filter(({secondary}) => boundSpriteLifecycle.has(secondary)),
      ...createGroup90SpriteConfiguration(graph.manager, graph.resource.errors),
      ...createGroup90SpriteNotifications(graph.manager, graph.resource.errors),
      ...createGroup90SpriteTargets(graph.spriteTargets, graph.resource.errors).filter(
        ({secondary}) => boundSpriteTargets.has(secondary),
      ),
      ...createGroup90Windows(graph.windowState, graph.resource.errors),
      ...createGroup90SelectionProcess(
        graph.windowState,
        scheduler,
        data.procedureState,
        graph.clock,
        graph.input,
        graph.waits,
        graph.notifications,
        graph.cursorMotion,
        data.textSelection,
        graph.resource.errors,
      ).filter(
        ({secondary}) =>
          boundSelectionSettings.has(secondary) || (selectedFontProvider && secondary === 0xa0),
      ),
      ...createGroup90SelectionText(graph.windowState, graph.resource.errors).filter(
        ({secondary}) => secondary === 0xa7 || (selectedFontProvider && secondary === 0xa1),
      ),
      ...(selectedFontProvider
        ? createGroup90SelectionExtended(
            graph.windowState,
            scheduler,
            data.procedureState,
            graph.clock,
            graph.input,
            graph.waits,
            graph.notifications,
            graph.cursorMotion,
            data.textSelection,
            graph.resource.errors,
          )
        : []),
      ...createGroup90WindowBitmapGroups(graph.manager),
      ...createGroup90SelectionBitmaps(graph.manager, graph.resource.errors),
      ...createGroup90SelectionBitmapProcess(
        graph.manager,
        scheduler,
        data.procedureState,
        graph.clock,
        graph.input,
        graph.waits,
        graph.notifications,
        data.bitmapSelection,
        data.textSelection,
        data.independentIcon,
        graph.resource.errors,
      ).filter(({secondary}) => secondary === 0xb0 || secondary === 0xb1),
      ...createGroup90ImmediateIconDescription(graph.manager),
      ...createGroup90IndependentIcons(
        data.procedures,
        graph.input,
        data.procedureState,
        graph.clock,
        graph.cursorPolicy,
        data.independentIcon,
        graph.resource.errors,
      ).filter(({secondary}) => secondary !== 0xb6),
      ...createGroup91IndependentIconEx(
        data.procedures,
        graph.input,
        data.procedureState,
        graph.clock,
        graph.cursorPolicy,
        data.independentIcon,
        graph.resource.errors,
      ),
      ...createGroup91IndependentIconMotion(
        data.procedures,
        graph.input,
        data.procedureState,
        graph.clock,
        graph.cursorPolicy,
        data.independentIcon,
        data.splines,
        graph.resource.errors,
      ),
      ...createGroup90Groups(graph.groups, graph.resource.errors),
      ...createGroup90Maps(graph.maps, graph.resource.errors),
      ...createGroup90PerspectivePoint(),
      ...createGroup90TextProcessSettings(graph.windowState.textLayout, graph.resource.errors),
      ...(selectedFontProvider
        ? createGroup90TextDisplay(
            graph.windowState,
            scheduler,
            data.procedureState,
            graph.clock,
            graph.input,
            graph.resource.errors,
          )
        : []),
      ...createGroup90Knobs(graph.knobs, graph.resource.errors),
      ...createGroup90Filters(graph.filterDisplays, graph.resource.errors).filter(
        ({secondary}) =>
          boundFilterState.has(secondary) ||
          (graph.displayReadyForScriptGeometry && secondary === 0x66),
      ),
      ...createGroup91RasterSettings(graph.compositor, graph.fonts, control),
      ...createGroup91SurfaceScale(graph.surfaces, graph.resource.errors),
      ...createGroup91SurfaceSplat(graph.surfaces, graph.resource.errors),
      ...createGroup91SurfaceTransform(graph.surfaces, graph.resource.errors),
      ...createGroup91SurfaceColorMaskCopy(graph.surfaces, graph.resource.errors),
      ...createGroup91SpriteMask(graph.manager),
      ...createGroup91BitmapRegistration(
        graph.bitmapRegistration,
        graph.codecWorkers,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup91DisplacementMaps(graph.surfaces, graph.particleRandom, graph.resource.errors),
      ...createGroup91DisplacementGenerators(graph.surfaces, graph.resource.errors),
      ...createGroup91AngularDisplacement(graph.surfaces, graph.resource.errors),
      ...createGroup91Effectors(graph.filterDisplays, graph.resource.errors).filter(
        ({secondary}) =>
          boundEffectorState.has(secondary) ||
          (graph.displayReadyForScriptGeometry && (secondary === 0x65 || secondary === 0x67)),
      ),
      ...createGroup91KnobPointer(graph.knobs),
      ...createGroup91TranslatedDisplay(graph.manager).filter(
        ({secondary}) =>
          boundTranslatedDisplay.has(secondary) ||
          (graph.displayReadyForScriptGeometry && secondary === 0x05),
      ),
      ...createGroup91Landscapes(graph.landscapes, graph.resource.errors),
      ...createGroup91PresentationSettings(graph.display, graph.movieImageConfiguration),
      ...createGroup91SurfaceMovies(
        graph.surfaceMovieFactory,
        graph.surfaces,
        graph.movies,
        graph.movieFramePosition,
      ),
      ...createGroup91MfMovies(
        graph.mfMovieSession,
        graph.mfMovieVolume,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createTraditionalMovieSlots(
        graph.traditionalMovieSession,
        graph.frames,
        graph.traditionalMovieAudio,
        graph.resource.errors,
      ),
      ...createGroup91BackdropLayers(graph.manager, graph.resource.errors),
      ...createGroup91ObjectCoordinates(graph.manager, graph.resource.errors),
      ...createGroup91ObjectProperty(graph.manager, graph.resource.errors),
      ...createGroup91WindowState(graph.windowState, graph.resource.errors).filter(
        ({secondary}) =>
          boundWindowState.has(secondary) || (selectedFontProvider && secondary === 0x88),
      ),
      ...createGroup91TextSettings(graph.windowState.textLayout, graph.resource.errors).filter(
        ({secondary}) =>
          boundTextSettings.has(secondary) || (selectedFontProvider && secondary === 0x98),
      ),
      ...(selectedFontProvider
        ? createGroup91TextDisplay(
            graph.windowState,
            scheduler,
            data.procedureState,
            graph.clock,
            graph.input,
            graph.notifications,
            graph.resource.errors,
          )
        : []),
      ...createGroup91TextMetrics(graph.windowState.textLayout).filter(
        ({secondary}) =>
          boundTextMetrics.has(secondary) ||
          (selectedFontProvider && (secondary === 0x99 || secondary === 0x9b)),
      ),
      ...(selectedFontProvider
        ? createGroup91FontRasterSettings(graph.fonts, graph.resource.errors)
        : []),
      ...createGroup91TextTags(graph.text),
      ...createGroupB0FontNames(graph.fonts),
      ...(graph.displayReadyForScriptGeometry
        ? createGroupB0Shake(
            graph.host,
            graph.cursorPolicy,
            scheduler,
            data.procedureState,
            graph.particleRandom,
            graph.resource.errors,
          )
        : []),
      ...(selectedFontProvider ? createGroupB0InlineText(graph.inline, graph.resource.errors) : []),
      ...(selectedFontProvider
        ? createGroupB0Fonts(graph.fontResources, graph.localized.language).filter(
            ({secondary}) => secondary !== 0xc0 && secondary !== 0xc1,
          )
        : []),
      ...createCustomTextGlyphSettings(graph.windowState.textLayout, graph.resource.errors),
      ...createTextLayoutSettings(graph.windowState.textLayout, graph.resource.errors),
      ...(selectedFontProvider
        ? createHorizontalTextLayoutServices(graph.windowState, graph.resource.errors)
        : []),
      ...createGroup92RegisteredLinkFont(graph.windowState.textLayout),
      ...(selectedFontProvider
        ? createGroup92TextResults(graph.windowState, graph.resource.errors).filter(({secondary}) =>
            [0x94, 0x95, 0x99, 0x9b, 0x9e, 0x9f].includes(secondary),
          )
        : []),
      ...(selectedFontProvider
        ? createGroup92TextDisplay(
            graph.windowState,
            scheduler,
            data.procedureState,
            graph.clock,
            graph.input,
            graph.notifications,
            graph.resource.errors,
          )
        : []),
      ...createGroup92CoefficientTables(graph.surfaces, graph.resource.errors),
      ...createGroup92HaloMask(graph.surfaces, graph.resource.errors),
      ...createGroup92AlphaExtraction(
        graph.surfaces,
        graph.manager.environment,
        graph.resource.errors,
      ),
      ...createGroup92ImmediateBmp(graph.surfaces, graph.resource.resources),
      ...createGroup92SurfacePixels(graph.surfaces),
      ...createGroup92SurfaceMovies(graph.surfaceMovieFactory, graph.surfaces, graph.movies),
      ...(selectedFontProvider
        ? createGroup92FontTransform(graph.fonts, graph.resource.errors)
        : []),
      ...(selectedFontProvider
        ? createGroup92SurfaceText(graph.surfaces, graph.resource.errors)
        : []),
      ...(selectedFontProvider
        ? createGroup92MonochromeText(graph.monochromeText, graph.resource.errors)
        : []),
      ...createGroup92SurfaceMasks(graph.surfaces, graph.resource.errors),
      ...createGroup92VectorMaps(graph.surfaces, graph.resource.errors),
      ...createGroup92ObjectLifecycle(graph.manager),
      ...createGroup92WindowImages(graph.windowState, graph.resource.errors),
      ...createGroupA0StreamLoad(graph.resource.music, graph.resource.errors),
      ...createGroupA0MusicLoad(
        graph.resource.worker,
        scheduler,
        data.procedureState,
        graph.clock,
        control,
      ),
      ...createGroupA0PairedMusicLoad(graph.resource.music, graph.resource.errors),
      ...createGroupA0SoundProcesses(
        graph.resource.worker,
        scheduler,
        data.procedureState,
        graph.clock,
      ).filter(({secondary}) => [0x20, 0x21, 0x23, 0x27, 0x28].includes(secondary)),
      ...createGroupA0StaticDuration(graph.resource.statics, graph.resource.errors),
      ...createGroupA0StaticPlay(graph.resource.statics, graph.resource.errors),
      ...createGroup90BmvResources(
        graph.bmvRegistry,
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroup90BmvFrame(
        graph.bmvService,
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
        control,
      ),
      ...createGroup92BmvResources(
        graph.bmvRegistry,
        graph.resource.loading,
        scheduler,
        data.procedureState,
        graph.clock,
      ),
      ...createGroupE0Records(data.counts, data.allocations),
      ...createGroupE0Files(graph.resource.files, graph.folders, data.counts, data.allocations),
      ...createGroupE0BitmapDescription(graph.text),
    ];
    const keys = new Set<string>();
    for (const definition of definitions) {
      const key = `${definition.primary}:${definition.secondary}`;
      if (
        BURIKO_NATIVE_SLOT_ADDRESSES[definition.primary]?.[definition.secondary] !==
        definition.nativeAddress
      )
        throw new Error(`Buriko VM fragments have an invalid inventory address ${key}`);
      if (keys.has(key)) throw new Error(`Buriko VM fragments duplicate ${key}`);
      keys.add(key);
    }
    return definitions.map((definition) => ({
      ...definition,
      execute: (context) => {
        this.core.assertNativeAdmission();
        if (context.memory !== data.memory || context.diagnostics !== this.core.diagnostics)
          throw new Error('Buriko VM fragments require the core BP memory and diagnostics');
        return this.core.runNativeCallback(() => definition.execute(context), context.thread);
      },
    }));
  }
}
