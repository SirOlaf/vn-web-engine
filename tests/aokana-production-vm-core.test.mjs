import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoProductionVmCore} from '../dist/engines/buriko/native/production-vm-core.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('one production VM core loads a mounted boot child under its unbound root', async () => {
  const fixture = await createMountedVmFixture({boot: false, seedCoreArchives: true});
  const {
    graph,
    paths,
    text,
    memory,
    data,
    diagnostics,
    core,
    definitions,
    selectedArchive,
    selectedModule,
    invoke,
  } = fixture;
  const resourcePayload = Uint8Array.of(41, 43, 47, 53, 59);
  try {
    assert.equal(graph.launchSelection.files, graph.resource.files);
    assert.equal(graph.launchSelection.paths, paths);
    assert.equal(graph.launchSelection.resources, graph.resource.resources);
    assert.equal(graph.launchSelection.errors, graph.resource.errors);
    assert.equal(graph.launchSelection.text, graph.text);
    assert.equal(graph.launchSelection.launcherFlag, 1);
    assert.equal(graph.resource.resources.configuration.nativeFileRoot, 'C:\\game\\');
    assert.equal(paths.currentDirectory, 'C:\\game');
    graph.launchSelection.copyBootNames(selectedArchive, selectedModule);
    assert.equal(text.decodeAuto({bytes: selectedArchive, offset: 0}), 'system.arc');
    assert.equal(text.decodeAuto({bytes: selectedModule, offset: 0}), 'ipl._bp');

    assert.equal(core.data, data);
    assert.equal(core.memory, memory);
    assert.equal(core.procedureState, data.procedureState);
    assert.equal(core.worker, graph.resource.worker);
    assert.equal(core.launchSelection, graph.launchSelection);
    assert.equal(core.root.id, 0);
    assert.equal(core.root.moduleCapacity, 0);
    assert.equal(core.scheduler.root.state, core.root);
    assert.equal(core.control.nextThreadId, 1);
    assert.equal(core.loader.resources, graph.resource.resources);
    assert.equal(core.loader.control, core.control);
    assert.equal(core.loader.scheduler, core.scheduler);
    assert.equal(core.loader.diagnostics, diagnostics);
    assert.equal(core.gate.scheduler, core.scheduler);
    assert.equal(core.gate.loading, graph.resource.loading);
    assert.equal(core.fragments.graph, graph);
    assert.equal(core.fragments.data, data);
    assert.ok(
      core.fragments
        .nativeDefinitions()
        .some((definition) => definition.primary === 0x80 && definition.secondary === 0x50),
    );
    assert.throws(
      () => new BurikoProductionVmCore(graph, data, diagnostics),
      /already has a VM core/,
    );

    const id = await fixture.bootChild();
    assert.equal(id, 1);
    assert.equal(core.control.nextThreadId, 2);
    const child = core.scheduler.firstThread;
    assert.ok(child);
    assert.equal(child.state, core.scheduler.findById(id).state);
    assert.equal(child.state.moduleSize, 4);
    assert.deepEqual([...child.state.moduleMemory.subarray(0, 4)], [0x11, 0x22, 0x33, 0x44]);

    const keys = definitions.map(({primary, secondary}) => `${primary}:${secondary}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const secondary of [
      0x40, 0x44, 0x41, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x52, 0x53, 0x54, 0x58,
      0x59, 0x5a, 0x5d, 0x5e, 0x5f, 0x6a,
    ])
      assert.ok(
        definitions.some((entry) => entry.primary === 0x80 && entry.secondary === secondary),
      );
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.resource.errors.dialogs, graph.dialogs);
    assert.equal(core.memory, memory);
    assert.equal(core.diagnostics, diagnostics);
    assert.equal(await invoke(0x91, 0x0b, [0x87654321], 0), 0);
    assert.equal(core.control.distributedBitmapProcessingEnabled, 0x87654321);
    assert.equal(await invoke(0x80, 0xfd, [], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);

    assert.equal(await invoke(0x80, 0x5c, [100, 0, 5], 2), 0);
    assert.ok(child.process);
    assert.equal(child.pollProcess(false), 0);
    assert.equal(await invoke(0x80, 0x50, [0], 1), 0);
    assert.equal(core.procedureState.enabled, 0);
    assert.equal(child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);

    assert.equal(await invoke(0x80, 0x52, [0x87654321], 0), 0);
    assert.equal(core.control.loopOption, 0x87654321);
    assert.equal(await invoke(0x80, 0x50, [1], 1), 0);
    assert.equal(await invoke(0x80, 0x54, [0x401], 2), 0);
    assert.ok(child.process);
    assert.equal(graph.waits.consume(child.state, 0x401)?.received, false);
    assert.equal(graph.messages.send('main', 0x401, 0x123456789n, -1n), 0);
    assert.equal(child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0xffffffff);
    assert.equal(pop32(child.state), 0x23456789);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(graph.waits.consume(child.state, 0x401), null);

    const resourceActor = {};
    const enqueuedActors = [];
    const originalEnqueue = graph.resource.loading.enqueue.bind(graph.resource.loading);
    graph.resource.loading.enqueue = (...args) => {
      enqueuedActors.push(args[8]);
      return originalEnqueue(...args);
    };
    memory.globalMemory.set(new TextEncoder().encode('data.arc\0'), 0x140);
    memory.globalMemory.set(new TextEncoder().encode('entry\0'), 0x160);
    assert.equal(await invoke(0x81, 0x30, [0x200, 0x140, 0x160, 1, 3], 0, resourceActor), 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual([...memory.globalMemory.subarray(0x200, 0x203)], [43, 47, 53]);
    assert.equal(graph.resource.loading.activeProcedures, 0);

    assert.equal(await invoke(0x80, 0x53, [], 0), 0);
    assert.equal(await invoke(0x81, 0x30, [0x220, 0x140, 0x160, 0, 0], 2, resourceActor), 0);
    assert.equal(core.control.asynchronousResourceLoads, 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(graph.resource.loading.hasPending, true);
    assert.equal(enqueuedActors.at(-1), resourceActor);
    assert.equal(await graph.resource.loading.processNext(resourceActor), true);
    assert.equal(await child.pollProcess(false), 1);
    assert.deepEqual([...memory.globalMemory.subarray(0x220, 0x225)], [...resourcePayload]);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);

    assert.equal(await invoke(0x81, 0x34, [0x140, 0x160], 2, resourceActor), 0);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(graph.resource.loading.hasPending, true);
    assert.equal(enqueuedActors.at(-1), resourceActor);
    assert.equal(await graph.resource.loading.processNext(resourceActor), true);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(graph.resource.loading.hasPending, false);
    assert.equal(enqueuedActors.length, 2);
    assert.equal(child.state.stackIndex, 0);

    assert.equal(await invoke(0x81, 0x44, [16, 16, 16, 0], 0), 1);
    const sharedId = pop32(child.state);
    assert.equal(sharedId, 2);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.control.nextThreadId, 3);
    const shared = core.scheduler.findById(sharedId);
    assert.ok(shared);
    assert.equal(shared.state.sharedOwner, child.state);
    assert.equal(child.state.retentionCount, 1);

    memory.globalMemory.set(new TextEncoder().encode('system.arc\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('ipl._bp\0'), 0x120);
    assert.equal(await invoke(0x80, 0x40, [0x100, 0x120], 0), 1);
    assert.equal(pop32(child.state), 4);
    assert.equal(child.state.moduleSize, 8);
    assert.deepEqual([...child.state.moduleMemory.subarray(4, 8)], [0x11, 0x22, 0x33, 0x44]);
    assert.equal(await invoke(0x80, 0x44, [0x100, 0x120, 16, 32, 32], 0), 1);
    const linkedId = pop32(child.state);
    assert.equal(linkedId, 3);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.control.nextThreadId, 4);
    const linked = core.scheduler.findById(linkedId);
    assert.ok(linked);
    assert.equal(linked.state.moduleSize, 4);
    assert.deepEqual([...linked.state.moduleMemory.subarray(0, 4)], [0x11, 0x22, 0x33, 0x44]);

    memory.globalMemory.set(new TextEncoder().encode('C:\\restart\\next.arc\0'), 0x300);
    memory.globalMemory.set(new TextEncoder().encode('next._bp\0'), 0x340);
    assert.equal(await invoke(0x80, 0x6b, [0x300, 0x340], 5), 0);
    assert.equal(graph.resource.resources.configuration.nativeFileRoot, 'C:\\restart\\');
    assert.equal(
      text.decodeAuto({bytes: graph.resource.resources.configuration.primaryRoot, offset: 0}),
      'C:\\restart\\',
    );
    assert.equal(graph.resource.resources.configuration.secondaryRoot[0], 0);
    assert.equal(graph.resource.resources.configuration.secondaryMediaPath, '');
    assert.equal(paths.currentDirectory, 'C:\\restart');
    assert.equal(graph.launchSelection.launcherFlag, 1);
    assert.equal(graph.resource.errors.saveRoot.files, graph.resource.files);
    assert.equal(
      text.decodeAuto({bytes: graph.resource.errors.saveRoot.bytes, offset: 0}),
      'C:\\restart\\',
    );
    graph.launchSelection.copyBootNames(selectedArchive, selectedModule);
    assert.equal(text.decodeAuto({bytes: selectedArchive, offset: 0}), 'next.arc');
    assert.equal(text.decodeAuto({bytes: selectedModule, offset: 0}), 'next._bp');
    const selectedId = await core.loader.appendSelectedProgram(selectedArchive, selectedModule);
    assert.equal(selectedId, 4);
    assert.deepEqual(
      [...core.scheduler.findById(selectedId).state.moduleMemory.subarray(0, 3)],
      [0x55, 0x66, 0x77],
    );

    assert.equal(await invoke(0x80, 0x70, [0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(memory.globalMemory.length, 0x1000);
    assert.equal(data.memory.globalMemory, memory.globalMemory);
    memory.globalMemory[0x20] = 0x7b;
    assert.equal(await invoke(0x80, 0x71, [], 0), 0);
    assert.equal(memory.globalMemory[0x20], 0);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    const closing = fixture.close();
    assert.equal(fixture.close(), closing);
    await closing;
  }
});
