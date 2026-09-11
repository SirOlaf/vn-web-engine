import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativePixelShaders} from '../dist/engines/mages/games/chaos-head-noah/sc3/native-pixel-shaders.js';
import {nativeVideoShaders} from '../dist/engines/mages/games/chaos-head-noah/sc3/native-video-shaders.js';

test('shipped SM4 resource result swizzles survive translation before destination writes', async () => {
  for (const [file, programs] of [
    ['renderer-shader-evidence.json', nativePixelShaders],
    ['renderer-video-shader-evidence.json', nativeVideoShaders],
  ]) {
    const evidence = JSON.parse(await readFile(new URL(`../docs/${file}`, import.meta.url)));
    for (const [index, shader] of evidence.entries()) {
      const samples = shader.instructions.filter((i) => i.opcode === 69),
        lines = programs[index].split('\n').filter((l) => l.includes('=(texture('));
      assert.equal(lines.length, samples.length, shader.name);
      for (const [i, ins] of samples.entries()) {
        const resource = ins.args[2],
          channels = Array.from(
            {length: 4},
            (_, n) => 'xyzw'[(resource.swizzle >>> (n * 2)) & 3],
          ).join('');
        assert.equal(resource.selection, 1);
        assert.ok(
          lines[i].includes(`.xy)${channels === 'xyzw' ? '' : '.' + channels}).`),
          `${shader.name} sample ${i}: missing ${channels} result selection`,
        );
      }
    }
  }
  // The history font alpha is routed into r0.x; mask red remains unchanged.
  assert.match(nativePixelShaders[40], /texture\(atlas,.*\.wxyz\)\.xyzw/);
  assert.match(nativePixelShaders[40], /texture\(additionalAtlas0,.*\.xy\)\)\.xyzw/);
});
