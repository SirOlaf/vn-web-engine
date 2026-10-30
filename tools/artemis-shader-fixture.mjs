/** Known-source executable CPU shader registry. No game pixels are shown/rendered. */
import {compileArtemisShaderPreset} from '../dist/engines/artemis/raster-shader.js';
import {ArtemisShaderLibrary} from '../dist/engines/artemis/shader-library.js';
import {createHash} from 'node:crypto';
export function createArtemisShaderFixture(hash, readFile) {
  const compiled = [];
  const library = new ArtemisShaderLibrary(
    hash,
    readFile,
    {
      compile: async (id, bytes) => {
        const program = await compileArtemisShaderPreset(hash, bytes);
        let disposed = false;
        const shader = {
          kind: program.kind,
          shade: (...args) => {
            if (disposed) throw Error('CPU shader disposed');
            return program.shade(...args);
          },
          dispose: () => {
            disposed = true;
          },
        };
        const calibration =
          program.kind === 'raster'
            ? shader.shade((u, v) => [u, v, 0, 1], 0.5, 0.25, {
                alpha: 0.5,
                angle: 0,
                inter: 360,
                size: 0.125,
              })
            : program.kind === 'radial'
              ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.5, 0.25, {
                  alpha: 0.5,
                  ax: 0.5,
                  ay: 0.5,
                  size: 0.3,
                  fade: 0.5,
                })
              : /^(blur_[hv]_(?:plain|mask|aa|mask_aa))$/.test(program.kind)
                ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.5, 0.25, {
                    alpha: 0.5,
                    weights: [1, 0, 0, 0, 0, 0, 0, 0],
                    step: 0.01,
                    mask: () => [0, 0, 0, 0.5],
                    back: () => [0.25, 0.5, 0.75, 0.5],
                    backUV: [0.1, 0.2],
                  })
                : program.kind === 'dimhole' || program.kind === 'dimring'
                  ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.75, 0.5, {
                      alpha: 0.5,
                      centerX: 0.5,
                      centerY: 0.5,
                      radius: 0.2,
                      ratio: 2,
                      thick: 0.1,
                    })
                  : program.kind === 'mosaic'
                    ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.55, 0.35, {
                        alpha: 0.5,
                        size: 4,
                        ratio: 2,
                      })
                    : program.kind === 'noise'
                      ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.5, 0.25, {
                          alpha: 0.5,
                          size: 0.02,
                        })
                      : /^blur_(diag|pair_[hv]|k[xy]?(?:_premultiplied)?)$/.test(program.kind)
                        ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.5, 0.25, {
                            alpha: 0.5,
                            offset: 0.01,
                            size: 1,
                          })
                        : program.kind.startsWith('perspective')
                          ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.6, 0.6, {
                              alpha: 0.5,
                              centerX: 0.5,
                              centerY: 0.5,
                              scale: 0.5,
                              fade: 0.1,
                            })
                          : ['add', 'mul', 'compbr', 'compbrc', 'compdk', 'compdkc'].includes(
                                program.kind,
                              )
                            ? shader.shade(
                                () => [0.2, 0.4, 0.6, 0.8],
                                () => [0.5, 0.25, 0, 0.5],
                                0.5,
                                0.25,
                                {alpha: 0.5, param: 0.75},
                              )
                            : program.kind === 'screen'
                              ? shader.shade(
                                  () => [0.2, 0.4, 0.6, 0.8],
                                  () => [0.5, 0.25, 0, 0.5],
                                  0.5,
                                  0.25,
                                  {alpha: 0.5},
                                )
                              : program.kind === 'blur_h' || program.kind === 'blur_v'
                                ? shader.shade((u, v) => [u, v, 0.6, 0.8], 0.5, 0.25, {
                                    alpha: 0.5,
                                    step: 0.01,
                                    weights: [0.4, 0.2, 0.1, 0, 0, 0, 0, 0],
                                  })
                                : shader.shade(() => [0.2, 0.4, 0.6, 0.8], 0.5, 0.25, {
                                    alpha: 0.5,
                                    red: 0.1,
                                    green: 0.8,
                                    blue: 0.6,
                                  });
        compiled.push({
          id,
          kind: program.kind,
          sourceSha256: createHash('sha256').update(bytes).digest('hex'),
          executable: 'actual-CPU-preset',
          calibration: [...calibration],
        });
        return {shader};
      },
      dispose: (shader) => shader.dispose(),
    },
    (tag, reason, error) => {
      throw Error(`Artemis shader ${reason} failure: ${tag.args.get('file') ?? ''} ${error ?? ''}`);
    },
  );
  return {
    dispatch: (tag) => library.dispatch(tag),
    summary: () => ({
      mode: 'known-source-CPU-executable',
      gpuPreparation: false,
      gamePixelsRendered: false,
      compiled,
    }),
    close: () => library.close(),
  };
}
