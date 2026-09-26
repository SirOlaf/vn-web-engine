import {readFileSync} from 'node:fs';
import {sha256} from '../../index.mjs';

const directory = 'tools/native-lift/examples/cfg/';
const implementationPath = directory + 'implementations.mjs';
const sourceHash = sha256(readFileSync(new URL('./implementations.mjs', import.meta.url)));
const typeHash = sha256(readFileSync(new URL('./types.mts', import.meta.url)));
export const binary = {
  id: 'synthetic-cfg',
  programPath: '/synthetic-cfg.exe',
  executableSha256: sha256('synthetic CFG executable; never native code'),
  languageId: 'x86:LE:64:default',
  imageBase: '0x140000000',
};
const evidence = () => ({
  state: 'synthetic',
  references: [],
  notes: ['Synthetic metadata and ordinary in-memory values only'],
});
const signature = (parameters, returnType = 'i32') => ({
  parameters: Object.entries(parameters).map(([name, type]) => ({name, type})),
  returnType,
});
const signatures = {
  run: signature({
    context: {named: 'CounterState'},
    value: 'i32',
    chooseAlternate: 'bool',
    opaqueValue: 'unknown',
  }),
  bump: signature({context: {named: 'CounterState'}, value: 'i32'}),
  base: signature({value: 'i32'}),
  alternate: signature({value: 'i32'}),
  measureText: signature({value: 'unknown'}, 'u32'),
  measureList: signature({value: 'unknown'}, 'u32'),
  swapLoop: signature({count: 'u32'}, 'u32'),
};
const rvas = {
  run: '0x1000',
  bump: '0x1100',
  base: '0x2000',
  measureText: '0x3000',
  swapLoop: '0x4000',
};
export const bodyHash = (id) => sha256(`synthetic separately decoded body ${id}`);
function applicability(rva, implementation) {
  return {
    binarySha256: binary.executableSha256,
    rva,
    body: {
      kind: 'synthetic',
      sha256: bodyHash(implementation),
      provenance: {
        path: implementationPath,
        sha256: sourceHash,
        section: `synthetic body ${implementation}`,
      },
    },
  };
}
export function createDatabase() {
  return structuredClone({
    schemaVersion: 1,
    kind: 'native-mapping-database',
    binaries: [binary],
    types: [
      {
        id: 'CounterState',
        kind: 'reference',
        import: {
          module: directory + 'types.mjs',
          export: 'CounterState',
          source: {path: directory + 'types.mts', sha256: typeHash},
        },
        nativeBits: 64,
        nullable: false,
        mutability: 'mutable',
      },
      {id: 'UnknownText', kind: 'opaque', import: null, nullable: false},
      {id: 'UnknownList', kind: 'opaque', import: null, nullable: false},
    ],
    implementations: Object.entries(signatures).map(([id, signature]) => ({
      id,
      module: implementationPath,
      export: id,
      source: {path: implementationPath, sha256: sourceHash},
      signature,
      evidence: evidence(),
    })),
    functions: Object.entries(rvas).map(([implementation, rva]) => ({
      binarySha256: binary.executableSha256,
      rva,
      implementation,
      abi: {
        convention: 'custom',
        parameters: signatures[implementation].parameters.map((parameter) => ({
          ...parameter,
          location: {kind: 'unresolved', reason: 'Synthetic contract; no native ABI is asserted'},
        })),
        arguments: signatures[implementation].parameters.map((parameter) => ({
          parameter: parameter.name,
          source: {kind: 'parameter', name: parameter.name},
        })),
        returnLocation: {kind: 'unresolved', reason: 'Synthetic contract'},
      },
      evidence: evidence(),
    })),
    variantFamilies: [
      {
        id: 'math',
        kind: 'code',
        selector: {type: 'u32', values: [0, 1], initial: 0},
        operations: [
          {
            id: 'call',
            signature: signatures.base,
            targets: ['base', 'alternate'].map((implementation, selectorValue) => ({
              selectorValue,
              implementation,
              applicability: [applicability('0x2000', implementation)],
              evidence: evidence(),
            })),
          },
        ],
      },
      {
        id: 'shape',
        kind: 'type',
        selector: {type: 'u32', values: [0, 1]},
        operations: [
          {
            id: 'measure',
            signature: signatures.measureText,
            targets: ['measureText', 'measureList'].map((implementation, selectorValue) => ({
              selectorValue,
              implementation,
              applicability: [applicability('0x3000', implementation)],
              evidence: evidence(),
            })),
          },
        ],
        types: [
          {selectorValue: 0, type: {named: 'UnknownText'}, evidence: evidence()},
          {selectorValue: 1, type: {named: 'UnknownList'}, evidence: evidence()},
        ],
      },
    ],
  });
}
export const ref = (name) => ({ref: name});
export const constant = (value, type = 'i32') => ({
  constant: `0x${BigInt(value).toString(16)}`,
  type,
});
function provenance(id, rva) {
  const start = '0x' + (BigInt(binary.imageBase) + BigInt(rva)).toString(16),
    end = '0x' + (BigInt(start) + 255n).toString(16);
  const {id: ignored, ...identity} = binary;
  return {
    binary: identity,
    entryAddress: start,
    bodyRanges: [{start, end}],
    bodySha256: bodyHash(id),
    sourceKind: 'synthetic',
    sourceSha256: sha256(`synthetic decoded CFG ${id}`),
    exporter: 'synthetic-fixtures/v2',
    reviewReference: 'tests/tooling-native-cfg.test.mjs',
    assumptions: [
      'No native execution or equivalence claim',
      'Direct parameter and reference contracts are explicit in the local database',
    ],
  };
}
function sourceFactory(rva) {
  let sequence = 0;
  return () => ({
    address: '0x' + (BigInt(binary.imageBase) + BigInt(rva)).toString(16),
    sequence: sequence++,
  });
}
function functionLeaf(implementation, increment, variant) {
  const source = sourceFactory('0x2000');
  return {
    implementation,
    provenance: provenance(implementation, '0x2000'),
    variant,
    parameterValues: {value: 'input'},
    entryBlock: 'entry',
    blocks: [
      {
        id: 'entry',
        phis: [],
        operations: [
          {
            id: 'result',
            type: 'i32',
            opcode: 'INT_ADD',
            inputs: [ref('input'), constant(increment)],
            source: source(),
          },
        ],
        terminator: {opcode: 'RETURN', value: ref('result'), source: source()},
      },
    ],
  };
}
export function createModule() {
  const source = sourceFactory('0x1000');
  const call = (id, family, operation, argument) => ({
    id,
    opcode: 'VARIANT_CALL',
    family,
    operation,
    arguments: {value: argument},
    source: source(),
  });
  const push = (scopeId, family, selectorValue) => ({
    opcode: 'PUSH_VARIANT',
    scopeId,
    family,
    selectorValue,
    reviewReference: 'synthetic scoped variant contract',
    source: source(),
  });
  const pop = (scopeId) => ({opcode: 'POP_VARIANT', scopeId, source: source()});
  const add = (id, left, right) => ({
    id,
    type: 'i32',
    opcode: 'INT_ADD',
    inputs: [ref(left), ref(right)],
    source: source(),
  });
  const run = {
    implementation: 'run',
    provenance: provenance('run', '0x1000'),
    variant: null,
    parameterValues: {
      context: 'context',
      value: 'input',
      chooseAlternate: 'choice',
      opaqueValue: 'opaque',
    },
    entryBlock: 'entry',
    blocks: [
      {
        id: 'entry',
        phis: [],
        operations: [
          {
            id: 'seed',
            opcode: 'CALL',
            target: {binarySha256: binary.executableSha256, rva: '0x1100'},
            arguments: {context: ref('context'), value: ref('input')},
            source: source(),
          },
        ],
        terminator: {
          opcode: 'BRANCH',
          condition: ref('choice'),
          trueTarget: 'alternatePath',
          falseTarget: 'basePath',
          source: source(),
        },
      },
      {
        id: 'basePath',
        phis: [],
        operations: [],
        terminator: {opcode: 'JUMP', target: 'join', source: source()},
      },
      {
        id: 'alternatePath',
        phis: [],
        operations: [
          {
            id: 'adjusted',
            type: 'i32',
            opcode: 'INT_ADD',
            inputs: [ref('seed'), constant(1)],
            source: source(),
          },
        ],
        terminator: {opcode: 'JUMP', target: 'join', source: source()},
      },
      {
        id: 'join',
        phis: [
          {
            id: 'chosen',
            type: 'i32',
            incoming: {basePath: ref('seed'), alternatePath: ref('adjusted')},
            source: source(),
          },
        ],
        operations: [
          push('outerMath', 'math', 1),
          call('outer', 'math', 'call', ref('chosen')),
          push('innerMath', 'math', 0),
          call('inner', 'math', 'call', ref('chosen')),
          pop('innerMath'),
          call('restored', 'math', 'call', ref('chosen')),
          push('textShape', 'shape', 0),
          call('length', 'shape', 'measure', ref('opaque')),
          pop('textShape'),
          pop('outerMath'),
          {
            id: 'signedLength',
            type: 'i32',
            opcode: 'CAST',
            inputs: [ref('length')],
            source: source(),
          },
          add('part', 'outer', 'inner'),
          add('part2', 'part', 'restored'),
          add('result', 'part2', 'signedLength'),
        ],
        terminator: {opcode: 'RETURN', value: ref('result'), source: source()},
      },
    ],
  };
  return {
    schemaVersion: 2,
    kind: 'reviewed-cfg-module',
    entryImplementation: 'run',
    functions: [
      run,
      functionLeaf('base', 1, null),
      functionLeaf('alternate', 10, {
        kind: 'decoded-body',
        family: 'math',
        selectorValue: 1,
        reviewReference: 'synthetic separately decoded second body',
      }),
    ],
  };
}
export function createLoopModule() {
  const source = sourceFactory('0x4000');
  return {
    schemaVersion: 2,
    kind: 'reviewed-cfg-module',
    entryImplementation: 'swapLoop',
    functions: [
      {
        implementation: 'swapLoop',
        provenance: provenance('swapLoop', '0x4000'),
        variant: null,
        parameterValues: {count: 'limit'},
        entryBlock: 'entry',
        blocks: [
          {
            id: 'entry',
            phis: [],
            operations: [],
            terminator: {opcode: 'JUMP', target: 'loop', source: source()},
          },
          {
            id: 'loop',
            phis: [
              {
                id: 'a',
                type: 'u32',
                incoming: {entry: constant(10, 'u32'), body: ref('b')},
                source: source(),
              },
              {
                id: 'b',
                type: 'u32',
                incoming: {entry: constant(20, 'u32'), body: ref('a')},
                source: source(),
              },
              {
                id: 'count',
                type: 'u32',
                incoming: {entry: constant(0, 'u32'), body: ref('next')},
                source: source(),
              },
            ],
            operations: [
              {
                id: 'again',
                type: 'bool',
                opcode: 'INT_LESS',
                inputs: [ref('count'), ref('limit')],
                source: source(),
              },
            ],
            terminator: {
              opcode: 'BRANCH',
              condition: ref('again'),
              trueTarget: 'body',
              falseTarget: 'done',
              source: source(),
            },
          },
          {
            id: 'body',
            phis: [],
            operations: [
              {
                id: 'next',
                type: 'u32',
                opcode: 'INT_ADD',
                inputs: [ref('count'), constant(1, 'u32')],
                source: source(),
              },
            ],
            terminator: {opcode: 'JUMP', target: 'loop', source: source()},
          },
          {
            id: 'done',
            phis: [],
            operations: [],
            terminator: {opcode: 'RETURN', value: ref('a'), source: source()},
          },
        ],
      },
    ],
  };
}
