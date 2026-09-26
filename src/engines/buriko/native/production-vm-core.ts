import {BurikoBpScheduler} from '../bp/scheduler.js';
import {BurikoBpThread} from '../bp/state.js';
import type {BurikoBpMemory} from '../bp/memory.js';
import {BurikoBootProgramLoader} from './boot-program-loader.js';
import {BurikoBootTerminationGate} from './boot-termination-gate.js';
import {BurikoDataDecodeProcess} from './data-decode-process.js';
import {BurikoInternetReadProcess} from './internet-read-process.js';
import {BurikoInstallationService} from './installation.js';
import {BurikoBpDiagnostics} from './diagnostics.js';
import {BurikoVmControlState} from './group-80-threads.js';
import type {BurikoLaunchSelection} from './launch-selection.js';
import {BurikoProductionDataOwners} from './production-data-owners.js';
import {BurikoProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import {BurikoProductionNativeFragments} from './production-native-fragments.js';
import {BurikoStructCodecScratch} from './struct-codec-scratch.js';
import {BurikoVmFrameHistory} from './system-timing.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoSharedLoaderWorker} from './shared-loader-worker.js';
import type {BurikoBpInstructionResult} from './types.js';

const boundDataOwners = new WeakSet<BurikoProductionDataOwners>();

/** One root and VM control owner over the mounted production graph and BP data bundle.
 * The scheduler remains unbound until a complete native bank can construct its interpreter.
 */
export class BurikoProductionVmCore {
  readonly memory: BurikoBpMemory;
  readonly procedureState: BurikoProcedureState;
  readonly worker: BurikoSharedLoaderWorker;
  readonly control: BurikoVmControlState;
  readonly launchSelection: BurikoLaunchSelection;
  /** ECB90's 600-DWORD timing ring, retained with the root across program restarts. */
  readonly frameHistory: BurikoVmFrameHistory;
  readonly root: BurikoBpThread;
  readonly scheduler: BurikoBpScheduler;
  readonly loader: BurikoBootProgramLoader;
  readonly gate: BurikoBootTerminationGate;
  readonly installation: BurikoInstallationService;
  readonly fragments: BurikoProductionNativeFragments;
  /** One reservation for all struct codec calls during this VM lifetime. */
  readonly structCodecScratch: BurikoStructCodecScratch;
  private nativeAdmissionClosed = false;
  private pendingNativeCallbacks = 0;
  private nativeDrainWaiters: Array<() => void> = [];
  private finalClosing: Promise<void> | null = null;

  constructor(
    readonly graph: BurikoProductionDisplayResourceGraph,
    readonly data: BurikoProductionDataOwners,
    readonly diagnostics: BurikoBpDiagnostics,
  ) {
    if (
      !(graph instanceof BurikoProductionDisplayResourceGraph) ||
      !(data instanceof BurikoProductionDataOwners) ||
      data.graph !== graph ||
      data.gridWorkers.grids !== data.grids ||
      data.gridWorkers.allocator !== graph.allocator ||
      data.gridWorkers.mainProcessing !== graph.resource.processing ||
      data.procedures.manager !== graph.manager ||
      graph.spriteTargets.manager !== graph.manager ||
      graph.spriteTargets.input !== graph.input ||
      graph.cursorFrame.motion !== graph.cursorMotion ||
      graph.cursorFrame.policy !== graph.cursorPolicy ||
      graph.particleFrames.particles !== graph.particles ||
      graph.particleFrames.clock !== graph.clock ||
      graph.rainFrames.rain !== graph.rain ||
      graph.rainFrames.clock !== graph.clock ||
      graph.frames.metrics.clock !== graph.clock ||
      graph.frames.metrics.raster !== graph.device ||
      !(diagnostics instanceof BurikoBpDiagnostics)
    )
      throw new TypeError('Buriko VM core requires its graph, data bundle and BP diagnostics');
    if (boundDataOwners.has(data))
      throw new Error('Buriko production data bundle already has a VM core');

    this.memory = data.memory;
    this.procedureState = data.procedureState;
    this.worker = graph.resource.worker;
    this.structCodecScratch = new BurikoStructCodecScratch(4096);
    this.control = new BurikoVmControlState();
    this.launchSelection = graph.launchSelection;
    // ECB90 captures FE7D0's low DWORD immediately before root construction.
    this.frameHistory = new BurikoVmFrameHistory(Number(BigInt.asUintN(32, graph.clock.read())));
    this.root = new BurikoBpThread({
      id: this.control.allocateThreadId(),
      operandCapacity: 0,
      moduleCapacity: 0,
      frameCapacity: 0,
    });
    this.scheduler = new BurikoBpScheduler(this.root);
    this.scheduler.attachSharedLoaderWorker(this.worker);
    this.scheduler.attachGridEvaluationWorkers(data.gridWorkers);
    this.loader = new BurikoBootProgramLoader(
      graph.resource.resources,
      this.control,
      this.scheduler,
      diagnostics,
      graph.engineVersion,
    );
    this.gate = new BurikoBootTerminationGate(this.scheduler, graph.resource.loading);
    this.installation = new BurikoInstallationService(
      graph.resource.resources,
      graph.resource.loading,
      data.procedureState,
      graph.clock,
      graph.notifications,
      graph.localized,
      graph.registry,
    );
    this.fragments = new BurikoProductionNativeFragments(
      graph,
      data,
      this.scheduler,
      this.installation,
    );
    this.scheduler.bindProcessPollGuard(
      () =>
        this.hasPendingNativeCallbacks ||
        data.procedures.hasActivePoll ||
        data.procedures.hasActiveFrameLane,
    );
    data.procedures.bindNativeCallbackGuard(
      () =>
        this.hasPendingNativeCallbacks ||
        this.scheduler.hasActiveProcessPoll ||
        this.scheduler.hasActiveInvocation,
    );
    boundDataOwners.add(data);
  }

  assertNativeAdmission(): void {
    if (
      this.nativeAdmissionClosed ||
      this.graph.codecWorkers.admissionClosed ||
      this.data.gridWorkers.admissionClosed ||
      this.data.procedures.admissionClosed ||
      this.scheduler.processPollAdmissionClosed
    )
      throw new Error('Buriko production VM native admission is closed');
  }

  get pendingNativeCallbackCount(): number {
    return this.pendingNativeCallbacks;
  }

  get hasPendingNativeCallbacks(): boolean {
    return this.pendingNativeCallbacks !== 0;
  }

  /** Admit one VM definition call and retain its lease through Promise settlement. */
  runNativeCallback<T extends BurikoBpInstructionResult>(
    operation: () => T,
    thread?: BurikoBpThread,
  ): T {
    this.assertNativeAdmission();
    if (thread !== undefined) {
      const scheduled =
        thread === this.root ? this.scheduler.root : this.scheduler.findById(thread.id);
      if (scheduled?.state === thread && scheduled.process?.hasOutstandingExternalBorrow?.())
        throw new Error('Buriko native callback would replace a process borrowing BP storage');
    }
    if (
      this.data.procedures.hasActivePoll ||
      this.data.procedures.hasActiveFrameLane ||
      this.scheduler.hasActiveProcessPoll ||
      (this.scheduler.hasActiveInvocation &&
        (thread === undefined || !this.scheduler.isDispatchingInstructionFor(thread)))
    )
      throw new Error(
        'Buriko production VM native callback overlaps a frame or scheduler invocation',
      );
    this.pendingNativeCallbacks++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.pendingNativeCallbacks--;
      if (this.pendingNativeCallbacks === 0) {
        const waiters = this.nativeDrainWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
    try {
      const result = operation();
      if (typeof result !== 'number') {
        // Observe either settlement without replacing the Promise returned to the VM.
        void result.then(release, release);
      } else {
        release();
      }
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  joinPendingNativeCallbacks(): Promise<void> {
    if (this.pendingNativeCallbacks === 0) return Promise.resolve();
    return new Promise((resolve) => this.nativeDrainWaiters.push(resolve));
  }

  /** Manual ECB90 lane entry until the complete outer frame coordinator is mounted. */
  runIndependentPoll(kind: 'enabled'): Promise<0 | 1>;
  runIndependentPoll(kind: 'reset'): Promise<void>;
  runIndependentPoll(kind: 'enabled' | 'reset'): Promise<0 | 1 | void> {
    this.assertNativeAdmission();
    if (this.hasPendingNativeCallbacks)
      throw new Error('Buriko independent poll overlaps a native callback');
    return kind === 'enabled'
      ? this.data.procedures.pollEnabled()
      : this.data.procedures.resetEnabled();
  }

  /** Manual ECB90 prefix, ending before the general input and display lanes. */
  runPreInputFrame(): Promise<0 | 1 | void> {
    this.assertNativeAdmission();
    return this.data.procedures.withFrameLane((poll) => this.runPreInputSuffix(poll));
  }

  private async runPreInputSuffix(poll: {
    enabled: () => Promise<0 | 1>;
    reset: () => Promise<void>;
  }): Promise<0 | 1 | void> {
    const result =
      this.data.procedures.pollingPhase === 0 ? await poll.enabled() : await poll.reset();
    await this.graph.legacy169Flash?.poll();
    this.graph.spriteTargets.poll();
    this.graph.cursorFrame.step();
    return result;
  }

  /** ECB90 movie, particle and rain prefix through pre-input work; later lanes remain separate. */
  runKnownSimulationTailAndPreInputFrame(): Promise<0 | 1 | void> {
    return this.runFrameLanes(async (result) => result);
  }

  /** Hold the VM frame lane through its awaited display, GUI and phase-one suffix. */
  runFrameLanes<T>(
    suffix: (preInputResult: 0 | 1 | void, phaseOneEnabled: () => Promise<0 | 1>) => Promise<T>,
  ): Promise<T> {
    this.assertNativeAdmission();
    return this.data.procedures.withFrameLane(async (poll) => {
      this.graph.frames.metrics.begin();
      await this.graph.movies.serviceRepeat();
      this.graph.particleFrames.updateAll();
      this.graph.particleFrames.pollRefresh();
      this.graph.rainFrames.updateAll();
      this.graph.rainFrames.pollRefresh();
      this.graph.frames.metrics.end(0);
      const result = await this.runPreInputSuffix(poll);
      return suffix(result, poll.phaseOneEnabled);
    });
  }

  /** Final VM owner close. An outer coordinator must quiesce direct resource
   * producers, other noncodec processes, movie producers, and future spatial evaluators.
   * Program restart retains the root. */
  close(): Promise<void> {
    if (this.finalClosing !== null) return this.finalClosing;
    this.nativeAdmissionClosed = true;
    this.scheduler.beginFinalClose();
    this.data.procedures.beginFinalClose();
    this.data.gridWorkers.beginFinalClose();
    this.finalClosing = (async () => {
      let firstError: unknown;
      let failed = false;
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      };
      await attempt(() => this.joinPendingNativeCallbacks());
      await attempt(() => this.scheduler.joinPendingInvocation());
      await attempt(() => this.scheduler.joinPendingProcessPoll());
      // Accepted BF frame workers retain surface and registry entry locks. Finish
      // their queued slices before process and child BP storage can be retired.
      await attempt(() => this.graph.bmvPump.closeAndDrain());
      await attempt(() => this.graph.externalProcesses?.closeAndJoin());
      await attempt(() => this.graph.secondaryMedia?.closeAndJoin());
      await attempt(() => this.graph.legacy169Flash?.closeAndJoin());
      await attempt(() => this.installation.closeAndJoin());
      await attempt(() => this.graph.internetReads?.closeAndJoin());
      await attempt(() => this.data.procedures.joinPendingFrameLane());
      await attempt(() => this.data.procedures.joinPendingPoll());
      await attempt(() => this.data.gridWorkers.closeAndJoin());
      await attempt(() => this.graph.codecWorkers.closeAndJoin());
      await attempt(() => this.graph.resource.quiesceForVmClose());
      if (!this.data.gridWorkers.quiesced) {
        if (!failed) {
          failed = true;
          firstError = new Error('Buriko VM close retained live grid evaluator borrowers');
        }
        throw firstError;
      }
      let sharedLoaderQuiesced = false;
      await attempt(() => {
        sharedLoaderQuiesced = this.graph.resource.quiescedForVmClose;
      });
      if (!sharedLoaderQuiesced) {
        if (!failed) {
          failed = true;
          firstError = new Error('Buriko VM close retained live shared loader BP borrowers');
        }
        throw firstError;
      }
      if (this.graph.internetReads !== null && !this.graph.internetReads.quiesced) {
        if (!failed) {
          failed = true;
          firstError = new Error('Buriko VM close retained internet-read BP borrowers');
        }
        throw firstError;
      }
      // Joined codec procedures still publish a DWORD in dispose(). Retire them
      // while their child operand storage is live; final close discards that result.
      for (let node = this.scheduler.firstThread; node !== null; node = node.next)
        if (node.process instanceof BurikoDataDecodeProcess)
          await attempt(() => node.installProcess(null));
      // A host completion writes borrowed BP output outside the process poll lease.
      // Its operation and process latch are joined before disposing a live child process.
      for (let node = this.scheduler.firstThread; node !== null; node = node.next) {
        const process = node.process;
        if (process instanceof BurikoInternetReadProcess) {
          await process.joinOperation();
          node.installProcess(null);
        }
      }
      if (this.scheduler.root.process instanceof BurikoInternetReadProcess)
        throw new Error('Buriko root sentinel owns an internet-read process');
      let childrenRemoved = false;
      await attempt(() => {
        this.scheduler.removeAllChildren();
        if (this.scheduler.firstThread !== null)
          throw new Error('Buriko VM close left a linked child after removal');
        childrenRemoved = true;
      });
      // A failed child removal may retain registry borrowers. Future spatial
      // evaluators must join before reaching this final disposal.
      if (childrenRemoved) {
        await attempt(() => this.data.procedures.disposeFinal());
        await attempt(() => this.data.grids.disposeAll());
        await attempt(() => this.data.spatial.disposeAll());
        await attempt(() => this.data.worldMaps.disposeAll());
        await attempt(() => this.data.splines.disposeAll());
      }
      await attempt(() => this.root.disposeStorage());
      await attempt(() => this.structCodecScratch.dispose());
      if (failed) throw firstError;
    })();
    return this.finalClosing;
  }
}
