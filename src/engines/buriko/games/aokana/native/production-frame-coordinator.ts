import {AokanaProductionVmCore} from './production-vm-core.js';

export interface AokanaProductionFrameResult {
  readonly schedulerResult: 0 | 1 | 2;
  readonly pumpResult: number;
  readonly retireChildren: boolean;
}

/** One ECB90 live-child tick, ending at the ED040/7E970 retirement decision. */
export class AokanaProductionFrameCoordinator {
  private active = false;

  constructor(readonly core: AokanaProductionVmCore) {
    if (!(core instanceof AokanaProductionVmCore))
      throw new TypeError('Aokana frame coordinator requires the bound production VM');
    const {graph} = core;
    if (
      graph.externalProcessWindow.pump !== graph.guiPump ||
      graph.deviceEnumeration.frames !== graph.frames ||
      graph.nonclientMotion.controller !== graph.controller
    )
      throw new Error('Aokana frame coordinator requires the selected shared frame and GUI owners');
  }

  private async verticalFallback(frameResult: number): Promise<void> {
    const {graph, control} = this.core;
    if (frameResult >= 1 || graph.display.verticalSynchronization === 0) return;
    if (frameResult === 0) {
      await graph.threadSleep(1);
      return;
    }
    if (control.loopOption !== 0) {
      await graph.threadSleep(control.loopOption | 0);
      return;
    }
    if (await this.waitForPhysicalBlank()) return;
    await graph.threadSleep(1);
  }

  /** B10C0 uses the physical raster capability, distinct from software present timing. */
  private async waitForPhysicalBlank(): Promise<boolean> {
    const {graph} = this.core;
    const display = graph.display;
    if (display.physicalRasterStatus === 0 || display.verticalSynchronization === 0) return false;
    const sample: {scanline?: number} = {};
    if (graph.device.readRasterScanline(sample) !== 0) return true;
    let previous = 0;
    while (sample.scanline !== undefined && previous <= (sample.scanline >>> 0)) {
      const current = sample.scanline >>> 0;
      const threshold = (display.scanlineHeight - display.scanlinesPerMillisecond - 1) >>> 0;
      if (threshold <= current) {
        while (graph.device.readRasterScanline(sample) === 0)
          await graph.threadSleep(0);
        return true;
      }
      await graph.threadSleep(1);
      if (graph.device.readRasterScanline(sample) !== 0) return true;
      previous = current;
    }
    return true;
  }

  async tick(): Promise<AokanaProductionFrameResult> {
    if (this.active) throw new Error('Aokana ECB90 frame tick is already active');
    this.active = true;
    try {
      const {core} = this;
      const {graph, gate, control} = core;
      core.assertNativeAdmission();
      if (core.scheduler.firstThread === null)
        throw new Error('Aokana ECB90 frame tick requires a live boot child');
      const distributed = control.distributedBitmapProcessingEnabled !== 0;
      if (distributed) graph.compositor.processing = graph.resource.processing;
      let schedulerResult: 0 | 1 | 2;
      try {
        schedulerResult = await core.scheduler.run();
      } finally {
        if (distributed) graph.compositor.processing = null;
      }
      gate.observeSchedulerResult(schedulerResult);
      const pumpResult = await core.runFrameLanes(async (_preInputResult, phaseOneEnabled) => {
        graph.input.collect(1, 1);
        graph.properties.refresh(0);
        const frameResult = await graph.frames.poll();
        await this.verticalFallback(frameResult);
        graph.gamepads?.poll();
        const pumped = await graph.guiPump.pumpMessages();
        gate.observePumpResult(pumped);
        graph.deviceEnumeration.poll();
        await graph.controller.poll();
        core.frameHistory.record(Number(BigInt.asUintN(32, graph.clock.read())));
        await graph.nonclientMotion.poll();
        graph.knobs.pollPointerInteraction();
        if (core.data.procedures.pollingPhase === 1) await phaseOneEnabled();
        return pumped;
      });
      return {schedulerResult, pumpResult, retireChildren: gate.canRetireChildren};
    } finally {
      this.active = false;
    }
  }
}
