import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {EMOTE_DRIVER_D3D11} from '../dist/native/emotedriver/contract.js';
import {ARTEMIS_3258_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {openArtemisRuntimeFixture} from './artemis-runtime-fixture.mjs';

const encode = (text) => new TextEncoder().encode(text);
const normalize = (path) => path.replace(/\\/g, '/').toLowerCase();

async function exercise(requests) {
  // A distinct synthetic DLL identity supplies the public contract. No native
  // implementation, PSB parser or game bytes participate in this cache test.
  const dll = Uint8Array.of(17, 29, 41),
    identity = {kind: 'image', sha256: createHash('sha256').update(dll).digest('hex')},
    reads = [],
    creations = [],
    players = [];
  let deviceReferences = 1,
    detached = 0;
  const device = {
    setMaskMode: (mode) => assert.equal(mode, 1),
    createPlayers(images) {
      creations.push(images.map((bytes) => [...bytes]));
      deviceReferences++;
      const player = {
        references: 1,
        release() {
          assert.equal(this.references, 1);
          this.references = 0;
          deviceReferences--;
          return 0;
        },
        progress: () => {},
      };
      players.push(player);
      return player;
    },
    release() {
      assert.ok(deviceReferences > 0);
      return --deviceReferences;
    },
  };
  const libraries = new NativeLibraryLoader(
    [
      {
        contract: EMOTE_DRIVER_D3D11,
        identities: [identity],
        imports: [],
        link: () => ({
          exports: {
            emoteGetSDKVersion: () => 'synthetic',
            emoteGetBuildDateTime: () => 'contract-cache-control',
            emoteCreate: () => device,
          },
          detach: () => detached++,
        }),
      },
    ],
    {locate: (name) => (name === 'emotedriver.dll' ? identity : null)},
  );
  const motionFiles = Object.fromEntries(
    Array.from({length: 20}, (_, index) => [
      `image/m${index}.psb`,
      Uint8Array.of(index, 255 - index),
    ]),
  );
  const luaRequests = requests
    .map((paths) => `{${paths.map((path) => JSON.stringify(path)).join(',')}}`)
    .join(',');
  const files = {
    'system.ini': encode('[WINDOWS]\nWIDTH=640\nHEIGHT=360\nBOOT=system/first.iet\n'),
    'emotedriver.dll': dll,
    ...motionFiles,
    'system/first.iet': encode(`[calllua function="exercise"]\n[stop]\n[lua]\nfunction exercise(e)
      for _, paths in ipairs({${luaRequests}}) do
        held=e:createEmoteLayer{id='cache',files=paths,width=4,height=4,progress=false}
      end
      verified=true
    end\n[/lua]`),
  };
  const fixture = await openArtemisRuntimeFixture(files, {
    hash: ARTEMIS_3258_EXECUTABLE_SHA256,
    services: {
      nativeGraphics: () => ({libraries, graphics: {device: {}, context: {}}}),
      files: {
        read: async (path) => {
          const resolved = normalize(path);
          if (resolved.startsWith('image/')) reads.push(resolved);
          return files[resolved] ?? null;
        },
        readPlain: async (path) => files[normalize(path)] ?? null,
        resolvePath: normalize,
        setMagicPath: () => {},
        paths: new Set(Object.keys(files)),
      },
    },
  });
  try {
    await fixture.runtime.boot();
    let suspensions = 0;
    while (fixture.runtime.resourcePending) {
      assert.ok(++suspensions <= requests.length + 1, 'A read batch must make progress');
      await fixture.runtime.settleResource();
      fixture.runtime.script.run(1000);
    }
    assert.equal(fixture.runtime.lua.vm.getGlobal('verified'), true);
    assert.deepEqual(
      creations,
      requests.map((paths) => paths.map((path) => [...files[normalize(path)]])),
    );
  } finally {
    await fixture.close();
    libraries.dispose();
  }
  assert.equal(players.length, requests.length);
  assert.ok(players.every((player) => player.references === 0));
  assert.equal(deviceReferences, 0);
  assert.equal(detached, 1);
  return reads;
}

test('Artemis motion inputs retain sixteen files in access order and share resolved aliases', async () => {
  const requests = [
    ...Array.from({length: 16}, (_, index) => [`image/m${index}.psb`]),
    ['IMAGE/M0.PSB'],
    ['image/m16.psb'],
    ['image/m0.psb'],
    ['image/m1.psb'],
    ['image/m1.psb'],
    ['image/m2.psb'],
  ];
  const reads = await exercise(requests);
  assert.equal(reads.length, 19);
  assert.equal(reads.filter((path) => path === 'image/m0.psb').length, 1);
  assert.equal(reads.filter((path) => path === 'image/m1.psb').length, 2);
  assert.equal(reads.filter((path) => path === 'image/m2.psb').length, 2);
});

test('A player with more motion files than the cache capacity loads one complete batch', async () => {
  const paths = Array.from({length: 20}, (_, index) => `image/m${index}.psb`);
  const reads = await exercise([paths, paths]);
  assert.equal(reads.length, 24);
  for (let index = 0; index < 20; index++)
    assert.equal(reads.filter((path) => path === `image/m${index}.psb`).length, index < 4 ? 2 : 1);
});
