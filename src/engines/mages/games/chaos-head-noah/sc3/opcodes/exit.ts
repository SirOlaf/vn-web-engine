import type {OpcodeExecution} from './types.js';

/** 00/34, 140055150. No PC advance and no context-local exit flag. */
export function requestApplicationExit(h: OpcodeExecution): void {
  h.yield();
  h.requestExit();
}
