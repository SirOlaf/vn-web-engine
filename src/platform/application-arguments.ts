/** Parsed application arguments supplied by the selected application/configuration owner.
 * These are application arguments, not the harness/host process command line.
 */
export interface ApplicationArgumentsHost {
  readApplicationArguments(): ReadonlyMap<string, string>;
}
