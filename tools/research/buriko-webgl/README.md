# Buriko WebGL 2 experiment

This archive preserves an exact integer GPU composition backend and its generated numerical verifier. It is not part of the player or runtime build. The complete synthetic scene measured 24.6 ms on WebGL 2 versus 24.2 ms in software, with slower first-use initialization; this does not justify a second runtime backend.

- `experiment.patch`: complete experiment relative to the commit in `base-commit.txt`, including runtime integration, observation tests, synthetic browser tools, and the text-presentation optimization used for measurement.
- `results.json`: final production-verifier output, without machine-local filesystem paths.
- `base-commit.txt`: exact source revision required to reproduce the experiment.

The patch must be applied to a separate clean checkout of that revision. It includes changes already present in newer software-renderer checkouts, so it is not a patch for the current working tree.

From the repository root:

```sh
git worktree add --detach ../vn-web-engine-gpu-probe e06c8cfc2a40f03a50cb85f03f882cff21d9d149
git -C ../vn-web-engine-gpu-probe apply "$PWD/tools/research/buriko-webgl/experiment.patch"
cd ../vn-web-engine-gpu-probe
npm ci
npm run build:runtime
node tools/verify-buriko-gpu.mjs --browser '/path/to/chromium'
```

Node.js 22 or newer and a Chromium-family browser are required. `--smoke` retains the numerical cases and reduces the scene to 320×180. The default scene is 1920×1080 with three measured frames. `--output` accepts a new JSON path; existing files are rejected. The tool reports actual GPU commands and completed readbacks so silent software fallback cannot pass eligible checks.

All inputs are generated numeric pixels and synthetic text. The verifier does not load game assets, take screenshots, or present framebuffer contents. The isolated kernel probe remains directly runnable in the current checkout as `tools/benchmark-buriko-webgl.mjs`.

See [GPU rendering research](../../../docs/gpu-rendering.md) for the native-equivalence requirements, complete measurement results, and criteria for reconsidering integration.
