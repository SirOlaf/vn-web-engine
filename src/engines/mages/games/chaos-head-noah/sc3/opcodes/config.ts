import type {OpcodeExecution} from './types.js';
import {initializeConfig, configCopy, configCopyVoices, resetConfigPage} from '../config-state.js';
import {interactConfig} from '../config-input.js';
/** Complete selector dispatch of 14005a050. No context-result write. */
export function configMenu(h: OpcodeExecution): void {
  h.skip(2);
  switch (h.byte()) {
    case 0:
    case 10:
      initializeConfig(h.state);
      return;
    case 1:
      interactConfig(h);
      return;
    case 2:
      configCopy(h.state, false);
      configCopyVoices(h.state, false, 32);
      h.state.put(0x17adc9c, h.state.get(0x5af924));
      return;
    case 3:
      h.state.put(0x17adc9c, h.state.get(0x17abdbc));
      return;
    case 4:
      resetConfigPage(h.state, h.storage.configuration);
      return;
    // All remaining byte selectors consume only their selector in native.
  }
}
