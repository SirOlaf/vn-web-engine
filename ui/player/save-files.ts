export interface SaveFileEntry {
  readonly id: string;
  readonly label: string;
}

/**
 * The save files of one game as the save file controls manage them. Each player supplies
 * one for the game that is open or chosen.
 */
export interface SaveFilesAdapter {
  /** File types the import picker offers. */
  readonly accept: string;
  /** Why no files can be managed yet, or null when they can. */
  readonly unavailable: string | null;
  /** Whether the list can be empty; fixed file sets always list every file. */
  readonly emptyLabel: string | null;
  list(): Promise<readonly SaveFileEntry[]>;
  read(id: string): Promise<{name: string; bytes: Uint8Array}>;
  /** Stores an imported file; `selected` is the entry chosen in the list. */
  import(
    name: string,
    bytes: Uint8Array,
    selected: string | null,
  ): Promise<{id: string | null; message: string}>;
}
