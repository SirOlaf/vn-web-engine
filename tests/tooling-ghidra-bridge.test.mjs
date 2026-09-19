import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildBridge} from '../tools/ghidra-bridge/build.mjs';

const root = fileURLToPath(new URL('../tools/ghidra-bridge/', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixture = async (name) =>
  JSON.parse(await readFile(join(root, 'fixtures', `synthetic-${name}.json`), 'utf8'));

function checkGraph(capture) {
  assert.equal(capture.status, 'complete');
  assert.equal(capture.schema, 'ghidra-function-export/v1');
  assert.deepEqual(capture.state.before, capture.state.after);
  assert.equal(capture.state.stable, true);
  assert.equal(capture.state.savedState, 'unverified');
  assert.equal(capture.raw.ssa, false);
  assert.equal(capture.high.ssa, true);
  const high = capture.high;
  const blocks = new Map(high.blocks.map((block) => [block.id, block]));
  const nodes = new Map(high.varnodes.map((node) => [node.id, node]));
  const ops = new Map(high.ops.map((op) => [op.id, op]));
  assert.equal(blocks.size, high.blocks.length);
  assert.equal(nodes.size, high.varnodes.length);
  assert.equal(ops.size, high.ops.length);
  assert.equal(high.opCount, ops.size);
  assert.ok(blocks.has(high.entryBlockId));
  const visitedOps = [];
  for (const block of high.blocks) {
    for (const [i, edge] of block.predecessors.entries()) {
      const reverse = blocks.get(edge.blockId).successors[edge.sourceSuccessorIndex];
      assert.equal(reverse.blockId, block.id);
      assert.equal(reverse.targetPredecessorIndex, i);
    }
    for (const [i, edge] of block.successors.entries()) {
      const reverse = blocks.get(edge.blockId).predecessors[edge.targetPredecessorIndex];
      assert.equal(reverse.blockId, block.id);
      assert.equal(reverse.sourceSuccessorIndex, i);
    }
    if (block.conditionalTargets) {
      const roles = block.conditionalTargets;
      assert.notEqual(roles.falseBlockId, roles.trueBlockId);
      assert.deepEqual(
        new Set([roles.falseBlockId, roles.trueBlockId]),
        new Set(block.successors.map((edge) => edge.blockId)),
      );
      assert.equal(ops.get(block.opIds.at(-1)).opcode, 'CBRANCH');
    }
    for (const [index, id] of block.opIds.entries()) {
      const op = ops.get(id);
      assert.equal(op.blockId, block.id);
      assert.equal(op.index, index);
      visitedOps.push(id);
      assert.ok(op.sequence.address.startsWith('0x'));
      for (const id of op.inputs) assert.ok(nodes.has(id));
      if (op.output !== null) assert.equal(nodes.get(op.output).definitionOpId, op.id);
      if (op.opcode === 'MULTIEQUAL') {
        assert.equal(op.phiInputs.length, block.predecessors.length);
        assert.equal(op.inputs.length, block.predecessors.length);
        for (const [i, phi] of op.phiInputs.entries()) {
          assert.equal(phi.inputIndex, i);
          assert.equal(phi.predecessorIndex, i);
          assert.equal(phi.varnodeId, op.inputs[i]);
          assert.equal(phi.predecessorBlockId, block.predecessors[i].blockId);
          assert.equal(phi.predecessorSuccessorIndex, block.predecessors[i].sourceSuccessorIndex);
        }
      }
    }
  }
  assert.deepEqual(
    visitedOps,
    high.ops.map((op) => op.id),
  );
  const spaceIds = new Set(capture.addressSpaces.map((space) => space.id));
  for (const node of high.varnodes) {
    assert.ok(spaceIds.has(node.spaceId));
    if (node.definitionOpId !== null) assert.ok(ops.has(node.definitionOpId));
  }
  assert.ok(high.inputVarnodeIds.every((id) => nodes.get(id).flags.input));
  assert.equal(capture.function.parameters[0].storage.pieces[0].register, 'ECX');
  assert.equal(capture.function.returnValue.storage.pieces[0].register, 'EAX');
}

test('actual synthetic Ghidra add capture separates raw storage operations from ordered HighFunction SSA', async () => {
  const capture = await fixture('add');
  checkGraph(capture);
  assert.deepEqual(
    capture.high.ops.map((op) => op.opcode),
    ['INT_ADD', 'COPY', 'RETURN'],
  );
  assert.equal(capture.function.bodySha256, hash(Buffer.from('8d4105c3', 'hex')));
  assert.equal(
    capture.raw.instructions.reduce((count, instruction) => count + instruction.length, 0),
    capture.function.bodyByteLength,
  );
});

test('actual synthetic diamond preserves predecessor order, phi association and explicit conditional roles', async () => {
  const capture = await fixture('branch');
  checkGraph(capture);
  assert.equal(capture.high.blocks.length, 4);
  assert.equal(capture.high.ops.filter((op) => op.opcode === 'MULTIEQUAL').length, 1);
  assert.equal(capture.high.blocks.filter((block) => block.conditionalTargets).length, 1);
});

test('actual synthetic countdown loop preserves backedges and distinct SSA values at repeated storage locations', async () => {
  const capture = await fixture('loop');
  checkGraph(capture);
  assert.equal(capture.high.ops.filter((op) => op.opcode === 'MULTIEQUAL').length, 3);
  const loopBlock = capture.high.blocks.find((block) =>
    block.successors.some((edge) => edge.blockId === block.id),
  );
  assert.ok(loopBlock);
  const grouped = new Map();
  for (const node of capture.high.varnodes.filter((node) => !node.flags.constant)) {
    const key = `${node.spaceId}/${node.offset}/${node.size}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node.id);
  }
  assert.ok(
    [...grouped.values()].some((ids) => new Set(ids).size > 1),
    'Storage identity must not replace SSA identity',
  );
});

// Explicit opt-in: this only starts an isolated synthetic ProgramDB process. It
// never connects to live Ghidra, reads a game, or executes invented instructions.
const ghidraInstall = process.env.VN_GHIDRA_TEST_INSTALL;
if (ghidraInstall)
  test(
    'builds an installable extension and exports synthetic ProgramDB graphs without executing target instructions',
    {timeout: 60000},
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), 'vn-ghidra-bridge-test-'));
      try {
        const build = await buildBridge({
          ghidraInstall,
          outputDirectory: join(temporary, 'build'),
          includeHarness: true,
        });
        const jarListing = execFileSync('jar', ['--list', '--file', build.receipt.artifact.path], {
          encoding: 'utf8',
        });
        assert.ok(jarListing.includes('NativeExportBridge/extension.properties'));
        assert.ok(jarListing.includes('NativeExportBridge/lib/NativeExportBridge.jar'));
        assert.equal(
          build.receipt.artifact.sha256,
          hash(await readFile(build.receipt.artifact.path)),
        );
        const productionJar = join(
          temporary,
          'build',
          'stage',
          'NativeExportBridge',
          'lib',
          'NativeExportBridge.jar',
        );
        assert.ok(
          !execFileSync('jar', ['--list', '--file', productionJar], {encoding: 'utf8'}).includes(
            'SyntheticExportCheck',
          ),
        );
        const output = join(temporary, 'synthetic');
        const run = spawnSync(
          build.java,
          [
            '-Djava.awt.headless=true',
            '-cp',
            [build.classes, build.classpath].join(delimiter),
            'vn.bridge.SyntheticExportCheck',
            ghidraInstall,
            output,
          ],
          {encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024},
        );
        assert.equal(run.status, 0, `${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`);
        assert.ok(run.stdout.includes('"targetInstructionsExecuted":false'));
        assert.ok(run.stdout.includes('"fileExports":5'));
        for (const name of ['add', 'branch', 'loop']) {
          checkGraph(JSON.parse(await readFile(join(output, `${name}.json`), 'utf8')));
          const bytes = await readFile(join(output, `${name}-file-both.json`));
          const receipt = JSON.parse(
            await readFile(join(output, `${name}-file-both.receipt.json`), 'utf8'),
          );
          checkGraph(JSON.parse(bytes));
          assert.equal(receipt.file.sha256, hash(bytes));
          assert.equal(receipt.file.byteLength, bytes.length);
          assert.equal(receipt.exporter.version, '0.2.0');
          assert.equal(receipt.raw, undefined);
          assert.equal(receipt.high, undefined);
          assert.ok(JSON.stringify(receipt).length < 4096);
        }
        await assert.rejects(
          () => buildBridge({ghidraInstall, outputDirectory: join(temporary, 'build')}),
          /EEXIST/,
        );
      } finally {
        await rm(temporary, {recursive: true, force: true});
      }
    },
  );
