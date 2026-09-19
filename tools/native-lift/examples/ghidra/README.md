# Actual synthetic Ghidra export to TypeScript

`loop.database.json` and `loop.plan.json` describe the preserved synthetic
countdown-loop capture from the dedicated bridge. Ghidra decoded and decompiled
invented bytes; no instructions were executed. The explicit signature comes from
this local database, and `reference.mjs` provides an independent scalar reference.

From the repository root, choose new output filenames:

```sh
node tools/native-lift/ghidra-cli.mjs inspect tools/ghidra-bridge/fixtures/synthetic-loop.json
node tools/native-lift/ghidra-cli.mjs import tools/ghidra-bridge/fixtures/synthetic-loop.json tools/native-lift/examples/ghidra/loop.database.json tools/native-lift/examples/ghidra/loop.plan.json /private/tmp/new-loop-cfg.json
node tools/native-lift/cfg-cli.mjs emit /private/tmp/new-loop-cfg.json tools/native-lift/examples/ghidra/loop.database.json /private/tmp/new-loop.ts
```

The emitted `lifted(value)` returns `0` for nonpositive signed inputs and the
wrapped signed 32-bit sum from `value` down to `1` otherwise. The captured graph has
three phi nodes, a loop backedge and a boolean combination. Use small ordinary
positive inputs when exploring it. The generated TypeScript can be inspected and
strict-checked without running it.

The [CFG examples](../cfg/module.json) separately demonstrate direct imports,
same-address variant bodies, code/type stacks, nested overrides and debug traces.
The importer test also compiles a synthetic direct call to the existing
`nativeVectorAngle` source implementation, without invoking game services.
