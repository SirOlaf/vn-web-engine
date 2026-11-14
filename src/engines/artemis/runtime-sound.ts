import type {ArtemisEffectVoices} from './effect-voices.js';
import type {ArtemisRuntimeSound} from './runtime.js';

/** The effect (script +0x3d88) and music (+0x3d60) managers of one voice owner. */
export interface ArtemisSoundManagers {
  readonly effects: ArtemisEffectVoices;
  readonly music: ArtemisEffectVoices;
}

/** The runtime sound service over the two managers. `advanceToTick` drives the managers'
 * scheduler ticks and whatever output the owner renders up to `now`. */
export function artemisRuntimeSound(
  managers: ArtemisSoundManagers,
  advanceToTick: (now: number) => void,
): ArtemisRuntimeSound {
  const {effects, music} = managers;
  return {
    prepareEffect: (file, bufferMode) => effects.prepareEffect(file, bufferMode),
    discardPreparedEffect: (index) => effects.discardPreparedEffect(index),
    stopEffect: (index, time) => effects.stopEffect(index, time),
    setEffectGain: (index, scope, gain, time) => effects.setEffectGain(index, scope, gain, time),
    setEffectPan: (index, pan, time) => effects.setEffectPan(index, pan, time),
    startEffect: (index, time, loop) => effects.startEffect(index, time, loop),
    setFinishCallback: (index, callback) => effects.setFinishCallback(index, callback),
    effectPlaying: (index) => effects.isPlaying(index),
    effectStartTick: (index) => effects.startTick(index),
    effectGain: (index, scope) => effects.effectGain(index, scope),
    prepareMusic: (file, bufferMode) => music.prepareEffect(file, bufferMode),
    discardPreparedMusic: (index) => music.discardPreparedEffect(index),
    stopMusic: (index, time) => music.stopEffect(index, time),
    setMusicGain: (index, scope, gain, time) => music.setEffectGain(index, scope, gain, time),
    setMusicPan: (index, pan, time) => music.setEffectPan(index, pan, time),
    startMusic: (index, time, loop) => music.startEffect(index, time, loop),
    setMusicFinishCallback: (index, callback) => music.setFinishCallback(index, callback),
    advanceToTick,
  };
}
