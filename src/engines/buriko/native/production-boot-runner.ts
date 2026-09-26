import {BrowserWindowsPostTeardownDialogHost} from '../../../platform/windows-post-teardown-dialog.js';
import {beginRuntimeActivity} from '../../../platform/runtime-activity.js';
import type {WindowsPostTeardownDialogHost} from '../../../platform/windows-post-teardown-dialog.js';
import {BrowserWindowsProcessInstanceHost} from '../../../platform/windows-process-instance.js';
import type {
  WindowsProcessInstanceHost,
  WindowsProcessInstanceLease,
} from '../../../platform/windows-process-instance.js';
import {BurikoAfterTeardownLaunch} from './after-teardown-launch.js';
import {BurikoBootOrderedReset} from './boot-ordered-reset.js';
import {BurikoProductionFrameCoordinator} from './production-frame-coordinator.js';
import {BurikoProductionInterpreter} from './production-interpreter.js';
import {BurikoProductionVmCore} from './production-vm-core.js';

/** ECB90 over one initialized graph, one complete native bank and one retained root. */
export class BurikoProductionBootRunner {
  readonly reset: BurikoBootOrderedReset;
  readonly frames: BurikoProductionFrameCoordinator;
  private running = false;

  private constructor(
    readonly core: BurikoProductionVmCore,
    readonly interpreter: BurikoProductionInterpreter,
    readonly postTeardownDialogs: WindowsPostTeardownDialogHost,
    readonly instanceLease: WindowsProcessInstanceLease | null,
  ) {
    if (interpreter.core !== core)
      throw new Error('Buriko boot runner requires the bound production interpreter');
    this.reset = new BurikoBootOrderedReset(core, interpreter);
    this.frames = new BurikoProductionFrameCoordinator(core);
  }

  /** C3900's selected display leg precedes FDEE0's one shared worker start. */
  static async start(
    core: BurikoProductionVmCore,
    postTeardownDialogs?: WindowsPostTeardownDialogHost,
    processInstances: WindowsProcessInstanceHost = new BrowserWindowsProcessInstanceHost(),
  ): Promise<BurikoProductionBootRunner> {
    if (!(core instanceof BurikoProductionVmCore))
      throw new TypeError('Buriko boot runner requires the production VM core');
    const {graph} = core;
    let instanceLease: WindowsProcessInstanceLease | null = null;
    try {
      await graph.launchSelection.configureFromCommandLine();
      if (graph.launchSelection.mutexEnabled !== 0) {
        const product = new TextDecoder()
          .decode(core.data.productIdentity.bytes)
          .replace(/\0.*$/s, '');
        instanceLease = await processInstances.acquire(
          `Buriko General Interpreter for ${product} is executing.`,
        );
        if (instanceLease === null) throw new Error('Buriko process instance is already active');
      }
      const initialized = await graph.initializeDisplayForEngineStartup();
      if (initialized !== 1) throw new Error('Buriko display initialization failed');
      graph.gamepads?.initialize();
      const interpreter = new BurikoProductionInterpreter(core);
      await graph.start();
      graph.initialized.completeStartup(1, () => 1);
      return new BurikoProductionBootRunner(
        core,
        interpreter,
        postTeardownDialogs ?? new BrowserWindowsPostTeardownDialogHost(graph.host.document),
        instanceLease,
      );
    } catch (error) {
      try {
        instanceLease?.release();
      } catch {
        // Startup failure remains primary; still close the VM and graph.
      }
      try {
        await core.close();
      } catch {
        // Startup failure remains the primary result; still release the graph.
      }
      try {
        await graph.shutdown();
      } catch {
        // Startup failure remains the primary result.
      }
      throw error;
    }
  }

  /** One initial boot, any script-selected restarts, then F41A0 and E1's optional handoff. */
  async run(): Promise<void> {
    if (this.running) throw new Error('Buriko outer boot runner is already active');
    this.running = true;
    const {core, interpreter} = this,
      {graph, scheduler, gate} = core;
    let failure: unknown = null;
    let failed = false;
    try {
      for (;;) {
        const finishLoading = beginRuntimeActivity('Loading game program');
        let child: number;
        try {
          const names = await this.reset.run();
          if (names === null) break;
          child = await core.loader.appendSelectedProgram(names.archive, names.module);
        } finally {
          finishLoading();
        }
        if (child === 0) break;
        gate.beginSuccessfulBoot(child);
        while (scheduler.firstThread !== null) {
          const result = await this.frames.tick();
          if (!result.retireChildren) continue;
          // 031BB0 closes the script section once; ECB90 does not reinitialize it
          // on a later program restart, so a second empty close has no work.
          if (graph.resource.scripts.hasLiveSection) await graph.resource.closeProgramScripts();
          scheduler.removeAllChildren();
        }
      }
    } catch (error) {
      failed = true;
      failure = error;
    }

    let launch: BurikoAfterTeardownLaunch | null = null;
    try {
      if (graph.externalProcesses !== null)
        launch = BurikoAfterTeardownLaunch.capture(
          interpreter.exitLaunch,
          graph.externalProcesses,
          this.postTeardownDialogs,
        );
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    let tornDown = true;
    try {
      await core.close();
    } catch (error) {
      tornDown = false;
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    try {
      await graph.shutdown();
    } catch (error) {
      tornDown = false;
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    try {
      this.instanceLease?.release();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (tornDown) {
      interpreter.exitLaunch.markEngineTornDown();
      try {
        await launch?.runAfterTeardown();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  }
}
