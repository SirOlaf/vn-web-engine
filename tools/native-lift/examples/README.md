# Synthetic integer leaf

`leaf.json` describes `(left + right) mod 2^64`, with artificial addresses and
hashes. It is not an Aokana function, a native export, or an equivalence receipt.
`registry.json` demonstrates an explicitly approved structural-pattern route.
The hand implementation is injected by the caller; generating code never imports
or executes its source.

```sh
node tools/native-lift/cli.mjs check tools/native-lift/examples/leaf.json
node tools/native-lift/cli.mjs emit tools/native-lift/examples/leaf.json
node tools/native-lift/cli.mjs emit tools/native-lift/examples/leaf.json tools/native-lift/examples/registry.json
node --test tests/tooling-native-lift.test.mjs
```

Redirect `emit` output to a scratch `.ts` file when needed. Generated code exports
`lifted(inputs, implementations)` and `liftReceipt`. A caller binds the sample
implementation as `{'synthetic-add-v1': implementation}`. The route pins source
bytes and the complete normalized IR; changing either requires a new review.
