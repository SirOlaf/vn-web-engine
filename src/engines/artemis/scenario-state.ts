import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisClickGlyph} from './click-glyph.js';
import type {ArtemisEventCommandFields} from './event-commands.js';
import type {ArtemisModeSaveFields} from './modes.js';
import type {ArtemisMusicHistory} from './music.js';
import type {
  ArtemisCaretRecord,
  ArtemisLoadedCaret,
  ArtemisLoadedScenario,
  ArtemisScenarioRecord,
} from './scenario-archive.js';
import type {ArtemisSaveDataSnapshot} from './save-data.js';
import {replayArtemisScenario, type ArtemisScenarioReplayHost} from './save-data.js';
import type {ArtemisMessageTweenType, ArtemisTweenDescriptor} from './scene-tweens.js';
import type {ArtemisScriptCaret, ArtemisScriptState} from './script.js';
import type {ArtemisTextControlFields} from './text-controls.js';
import type {ArtemisVariables} from './variables.js';

/** The script-level owners whose fields the scenario archive carries. */
export interface ArtemisScenarioOwners<Font extends object> {
  readonly modes: {
    saveFields(): ArtemisModeSaveFields;
    loadFields(fields: Partial<ArtemisModeSaveFields>): void;
  };
  readonly script: {
    carets(): ArtemisScriptCaret[];
    restoreCarets(carets: readonly ArtemisScriptCaret[]): void;
  };
  readonly keyBindings: {
    keyRoles(): ReadonlyMap<number, readonly number[]>;
    loadKeyRoles(roles: ReadonlyMap<number, readonly number[]>): void;
    pushHandlerMaps(): readonly [ReadonlyMap<number, AsbTag>, ReadonlyMap<number, AsbTag>];
    loadPushHandlers(
      maps: readonly [ReadonlyMap<number, AsbTag>, ReadonlyMap<number, AsbTag>],
    ): void;
  };
  readonly eventCommands: {
    saveFields(): ArtemisEventCommandFields;
    loadFields(fields: Partial<ArtemisEventCommandFields>): void;
  };
  readonly messageLayers: {layeredNames(): string[]};
  readonly messageSelection: {
    saveFields(): {readonly current: string; readonly stack: readonly string[]};
    loadFields(fields: {readonly current?: string; readonly stack?: readonly string[]}): void;
  };
  readonly textControls: {
    saveFields(): ArtemisTextControlFields;
    loadFields(fields: Partial<ArtemisTextControlFields>): void;
  };
  readonly sceneTweens: {
    saveFields(): Record<ArtemisMessageTweenType, Map<string, ArtemisTweenDescriptor[]>>;
    loadFields(
      fields: Readonly<
        Record<ArtemisMessageTweenType, ReadonlyMap<string, readonly ArtemisTweenDescriptor[]>>
      >,
    ): void;
  };
  readonly clickGlyphs: {
    saveFields(): ReadonlyMap<string, Readonly<ArtemisClickGlyph>>;
    loadFields(glyphs: ReadonlyMap<string, Readonly<ArtemisClickGlyph>>): void;
  };
  readonly events: {
    saveFields(): string[];
    loadFields(names: readonly (string | undefined)[]): void;
  };
  readonly saveData: {
    snapshot(): ArtemisSaveDataSnapshot<Font>;
    restore(snapshot: ArtemisSaveDataSnapshot<Font>): void;
  };
  readonly layerCommands: {
    snapshot(): ReadonlyMap<string, readonly AsbTag[]>;
    restore(snapshot: ReadonlyMap<string, readonly AsbTag[]>): void;
  };
  readonly music: {
    readonly history: ArtemisMusicHistory;
    restoreHistory(history: ArtemisMusicHistory): void;
  };
  readonly variables: ArtemisVariables;
}

/** Script fields without a dedicated owner, supplied by the host. */
export interface ArtemisScenarioScalars<Font extends object> {
  /** +0xb38 macro file list. */
  readonly macroFiles: readonly string[];
  /** +0xcf0 (right-click script running) and +0xcf4. */
  readonly autosaveFlag: number;
  readonly autosaveValue: number;
  /** +0x3524 / +0x3528. */
  readonly debugMode: number;
  readonly debugLevel: number;
  readonly field35b8: string;
  readonly field35d8: number;
  readonly field3880: number;
  /** +0x3628 default font property. */
  readonly font: Font;
}

/** Caret record inputs the script does not own: the wait flags (b94..bc8 of each caret). */
export interface ArtemisScenarioRunMode {
  /** Write the current caret as the loader restores it: the run modes the loader assigns
   * (see `writeArtemisCaret`) and no wait flag. */
  readonly asLoaded?: boolean;
  /** Any wait flag (timed, scenario, se or video wait) of the current caret is set. */
  readonly waiting: boolean;
  /** A call-stack frame's saved host caret fields include a set wait flag. */
  frameWaiting(fields: unknown): boolean;
}

const emptyBlock: AsbTag = {kind: 'tag', name: '', sourceLine: 0, args: new Map()};

/** The record writer 0x140140770 saves: owner fields, carets and the save object. The
 * engine backlog (section 0x1f) is passed by the host when transient state is included. */
export function captureArtemisScenario<Font extends object>(
  owners: ArtemisScenarioOwners<Font>,
  scalars: ArtemisScenarioScalars<Font>,
  runMode: ArtemisScenarioRunMode,
  backlog: ArtemisScenarioRecord<Font>['backlog'],
): ArtemisScenarioRecord<Font> {
  const modes = owners.modes.saveFields();
  const carets = owners.script.carets();
  const record = (caret: ArtemisScriptCaret, current: boolean): ArtemisCaretRecord => {
    const mode = caret.runMode ?? 0,
      previous = caret.previousRunMode ?? 0;
    // The loader assigns the two written modes: a waiting caret loads in mode 0 with its
    // mode as the previous one, a caret in mode 5 or above loads its previous mode.
    const loaded =
      current && runMode.asLoaded
        ? runMode.waiting
          ? [0, mode]
          : [mode >>> 0 < 5 ? mode : previous, previous]
        : [mode, previous];
    return {
      file: caret.file,
      index: caret.index,
      runMode: loaded[0]!,
      previousRunMode: loaded[1]!,
      waiting: current ? !runMode.asLoaded && runMode.waiting : runMode.frameWaiting(caret.fields),
      queue: caret.queue,
      tag: caret.tag ?? emptyBlock,
    };
  };
  const events = owners.eventCommands.saveFields();
  const selection = owners.messageSelection.saveFields();
  const text = owners.textControls.saveFields();
  return {
    automodeAllowed: modes.automodeAllowed,
    automode: modes.automode,
    automodeLayers: modes.automodeLayers,
    skipAllowed: modes.skipAllowed,
    commandSkip: modes.commandSkip,
    controlSkip: modes.controlSkip,
    macroFiles: scalars.macroFiles,
    alreadyRead: modes.alreadyRead,
    caret: record(carets.at(-1)!, true),
    callStack: carets.slice(0, -1).map((caret) => record(caret, false)),
    rightClickAllowed: modes.rightClickAllowed,
    rightClickScript: modes.rightClickScript,
    autosaveFlag: scalars.autosaveFlag,
    autosaveValue: scalars.autosaveValue,
    autosave: modes.autosave,
    debugMode: scalars.debugMode,
    debugLevel: scalars.debugLevel,
    stopAutoByClick: modes.stopAutoByClick,
    stopAutoByStop: modes.stopAutoByStop,
    syncSe: modes.syncSe,
    skipUnread: modes.skipUnread,
    field35b8: scalars.field35b8,
    field35d8: scalars.field35d8,
    currentMessageLayer: selection.current,
    messageSelection: selection.stack,
    font: scalars.font,
    sceneTweens: owners.sceneTweens.saveFields(),
    hideFlag: text.hideAllowed,
    hidden: text.hiddenWindows,
    backlogLayer: text.backlogMessageLayer,
    writeBacklog: modes.writeBacklog,
    backlogFlag: text.backlogIncludeFont,
    backlogAllowed: text.backlogAllowed,
    backlogNames: text.hiddenBacklogLayers,
    backlogIcons: new Map(
      [...text.backlogLayers].map(([name, layer]) => [
        name,
        {present: layer.useOverride, name: layer.layer},
      ]),
    ),
    glyphs: owners.clickGlyphs.saveFields(),
    field3880: scalars.field3880,
    pushHandlers: owners.keyBindings.pushHandlerMaps(),
    eventSlots: events.eventSlots,
    windowButtons: events.windowButtons,
    block3c80: events.windowButton,
    block3ce0: events.dirchg,
    luaEventNames: owners.events.saveFields(),
    saveObject: {
      data: owners.saveData.snapshot(),
      layerCommands: owners.layerCommands.snapshot(),
      music: owners.music.history,
    },
    keyRoles: owners.keyBindings.keyRoles(),
    layeredNames: owners.messageLayers.layeredNames(),
    backlog,
  };
}

export interface ArtemisScenarioLoadHost<
  Font extends object,
> extends ArtemisScenarioReplayHost<Font> {
  /** bf210 with flag 1. */
  reset(): void;
  /** Fields without a dedicated owner; absent sections keep the reset value. */
  loadScalars(scalars: Partial<ArtemisScenarioScalars<Font>>): void;
  /** Section 0x1f; absent unless the save included transient state. */
  loadBacklog(backlog: ArtemisScenarioRecord<Font>['backlog'] | undefined): void;
  /** Saved caret run mode fields into c70/c74, then run mode 13 (c74 = c70, c70 = 13 and
   * scheduler +0x30(0)) unless it is already 13. */
  enterLoadMode(caret: ArtemisLoadedCaret | undefined): void;
  /** The script state a call-stack frame with saved run mode `mode` resumes in. */
  frameState(mode: number): ArtemisScriptState | undefined;
  /** Per +0x3818 entry with a nonempty layer name, then rplayer name: renderer layer
   * lookup +0x140 and, when found, its virtual +0xf0(0). */
  refreshGlyphLayer(name: string): void;
  /** 0x1400c6480, then 0x1400b7810/0x1400b7ba0/0x1400b7c70 with zero arguments. */
  finishLoad(): void;
}

/** Loader 0x140141b10 after the archive has been read: reset, owner section reads, the
 * caret check, run mode 13, the tag replay and the run mode release. Every owner takes its
 * section by plain assignment; absent sections keep the reset values. The caret tag must
 * match the program tag at its index: native relocation by tag search is refused. */
export async function applyArtemisScenario<Font extends object>(
  owners: ArtemisScenarioOwners<Font>,
  loaded: ArtemisLoadedScenario<Font>,
  host: ArtemisScenarioLoadHost<Font>,
): Promise<void> {
  host.reset();
  owners.modes.loadFields({
    automodeAllowed: loaded.automodeAllowed,
    automode: loaded.automode,
    automodeLayers: loaded.automodeLayers,
    skipAllowed: loaded.skipAllowed,
    commandSkip: loaded.commandSkip,
    controlSkip: loaded.controlSkip,
    alreadyRead: loaded.alreadyRead,
    rightClickAllowed: loaded.rightClickAllowed,
    rightClickScript: loaded.rightClickScript,
    autosave: loaded.autosave as 0 | 1 | 2 | undefined,
    stopAutoByClick: loaded.stopAutoByClick,
    stopAutoByStop: loaded.stopAutoByStop,
    syncSe: loaded.syncSe,
    skipUnread: loaded.skipUnread,
    writeBacklog: loaded.writeBacklog,
  });
  host.loadScalars({
    macroFiles: loaded.macroFiles,
    autosaveFlag: loaded.autosaveFlag,
    autosaveValue: loaded.autosaveValue,
    debugMode: loaded.debugMode,
    debugLevel: loaded.debugLevel,
    field35b8: loaded.field35b8,
    field35d8: loaded.field35d8,
    field3880: loaded.field3880,
    font: loaded.font,
  });
  owners.messageSelection.loadFields({
    current: loaded.currentMessageLayer,
    stack: loaded.messageSelection,
  });
  if (loaded.sceneTweens) owners.sceneTweens.loadFields(loaded.sceneTweens);
  owners.textControls.loadFields({
    hideAllowed: loaded.hideFlag,
    hiddenWindows: loaded.hidden,
    backlogMessageLayer: loaded.backlogLayer,
    backlogIncludeFont: loaded.backlogFlag,
    backlogAllowed: loaded.backlogAllowed,
    hiddenBacklogLayers: loaded.backlogNames,
    backlogLayers:
      loaded.backlogIcons &&
      new Map(
        [...loaded.backlogIcons].map(([name, icon]) => [
          name,
          {useOverride: icon.present, layer: icon.name},
        ]),
      ),
  });
  if (loaded.glyphs) owners.clickGlyphs.loadFields(loaded.glyphs);
  if (loaded.pushHandlers) owners.keyBindings.loadPushHandlers(loaded.pushHandlers);
  owners.eventCommands.loadFields({
    eventSlots: loaded.eventSlots,
    windowButtons: loaded.windowButtons,
    windowButton: loaded.block3c80,
    dirchg: loaded.block3ce0,
  });
  if (loaded.luaEventNames) owners.events.loadFields(loaded.luaEventNames);
  owners.saveData.restore(loaded.saveObject.data);
  owners.layerCommands.restore(loaded.saveObject.layerCommands);
  owners.music.restoreHistory(loaded.saveObject.music);
  if (loaded.keyRoles) owners.keyBindings.loadKeyRoles(loaded.keyRoles);
  host.loadBacklog(loaded.backlog);
  if (loaded.variables)
    owners.variables.restoreScenario(loaded.variables.global, loaded.variables.locals);
  if (loaded.caret) {
    const frame = (caret: ArtemisLoadedCaret, resumeState?: ArtemisScriptState) => ({
      file: caret.file,
      index: caret.index,
      queue: caret.queue,
      tag: caret.tag.name ? caret.tag : null,
      runMode: caret.runMode,
      previousRunMode: caret.previousRunMode,
      resumeState,
    });
    owners.script.restoreCarets([
      ...(loaded.callStack ?? []).map((caret) => frame(caret, host.frameState(caret.runMode))),
      frame(loaded.caret),
    ]);
  }
  host.enterLoadMode(loaded.caret);
  await replayArtemisScenario(
    loaded.saveObject.data,
    loaded.layeredNames ?? [],
    loaded.saveObject.layerCommands,
    loaded.saveObject.music,
    host,
    () => {
      for (const glyph of loaded.glyphs?.values() ?? []) {
        if (glyph.layerName) host.refreshGlyphLayer(glyph.layerName);
        if (glyph.rplayerName) host.refreshGlyphLayer(glyph.rplayerName);
      }
    },
  );
  host.finishLoad();
}
