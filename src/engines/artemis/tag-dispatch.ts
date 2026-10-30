import type {AsbTag} from '../../formats/artemis/asb.js';

/** An owner whose tag completes synchronously. */
interface SyncOwner {
  dispatch(tag: AsbTag): boolean;
}
/** An owner that takes the native replay flag (`recordHistory` false while replaying). */
interface HistoryOwner {
  dispatch(tag: AsbTag, recordHistory?: boolean): boolean;
}
/** An owner whose tag loads resources: the promise settles when the native tag returns. */
interface ResourceOwner {
  dispatch(tag: AsbTag, recordHistory?: boolean): Promise<unknown>;
}

/** The layer owner of `lyc`/`lyprop`/`lydel`/`flip`/`lyevent`/`anime`/`animedel`/`video`,
 * transitions and layer tweens. */
export interface ArtemisLayerTagOwner {
  accepts(tag: AsbTag): boolean;
  dispatch(tag: AsbTag, recordHistory: boolean): Promise<unknown>;
  /** A rule transition returns its asynchronous rule load; others complete at once. */
  dispatchTransition(tag: AsbTag): unknown;
  dispatchTween(tag: AsbTag, recordHistory: boolean): void;
}

/** Every native tag owner, in the order the dispatcher consults them. Owners that need
 * message layers, glyph text, sound or graphics are absent when the host lacks them; their
 * tags then reach the unsupported-tag refusal. */
export interface ArtemisTagOwners {
  /** `print`, `ruby`, `/ruby`, `rt` and `rp` need all three text owners. */
  readonly print?: ResourceOwner;
  readonly ruby?: ResourceOwner;
  readonly textCommands?: ResourceOwner;
  readonly layers?: ArtemisLayerTagOwner;
  readonly fullscreenVideo: {
    accepts(tag: AsbTag): boolean;
    dispatch(tag: AsbTag): Promise<unknown>;
  };
  readonly messageSelection?: SyncOwner;
  readonly fontStack?: HistoryOwner;
  readonly sceneTweens?: SyncOwner;
  readonly textBreakControls?: HistoryOwner;
  readonly dialog: SyncOwner;
  readonly http?: SyncOwner;
  readonly keyBindings: SyncOwner;
  readonly eventCommands: SyncOwner;
  readonly nativeLibrary: SyncOwner;
  readonly textControls: SyncOwner;
  readonly modes: SyncOwner;
  readonly exec: SyncOwner;
  readonly variables: {dispatch(tag: AsbTag): boolean | Promise<boolean>};
  readonly caption: SyncOwner;
  readonly seStop: HistoryOwner;
  readonly seAdjust: HistoryOwner;
  readonly soundFinish?: SyncOwner;
  readonly mouse: SyncOwner;
  readonly wait: SyncOwner;
  readonly stop: SyncOwner;
  readonly shaders?: ResourceOwner;
  readonly reset: SyncOwner;
  readonly save: SyncOwner;
  readonly exit: SyncOwner;
  readonly load: {dispatch(tag: AsbTag): Promise<unknown>};
  readonly clickGlyphs: SyncOwner;
  readonly music?: {dispatch(tag: AsbTag, recordHistory?: boolean): boolean | Promise<unknown>};
  readonly sePlay?: ResourceOwner;
  readonly screenshots?: {dispatch(tag: AsbTag): boolean | Promise<boolean>};
  readonly fileCommands?: {dispatch(tag: AsbTag): boolean | Promise<boolean>};
}

/** Native command dispatch (the tag map consulted by 0x1400c5800) over the owners. A tag
 * that loads resources hands its promise to `suspend` and reports 'suspended'; the caller
 * resumes the script once it settles. `recordHistory` false is the loader replay flag. */
export function createArtemisTagDispatch(
  owners: ArtemisTagOwners,
  suspend: (operation: Promise<unknown>) => void,
): (tag: AsbTag, recordHistory?: boolean) => void | 'suspended' {
  const pending = (operation: Promise<unknown>): 'suspended' => {
    suspend(operation);
    return 'suspended';
  };
  const text = owners.print && owners.ruby && owners.textCommands;
  return (tag, recordHistory = true) => {
    if (text && ['print', 'ruby', '/ruby', 'rt', 'rp'].includes(tag.name))
      return pending(
        tag.name === 'print'
          ? owners.print!.dispatch(tag, recordHistory)
          : tag.name === 'ruby' || tag.name === '/ruby'
            ? owners.ruby!.dispatch(tag, recordHistory)
            : owners.textCommands!.dispatch(tag, recordHistory),
      );
    const layers = owners.layers;
    if (layers && tag.name === 'trans') {
      const result = layers.dispatchTransition(tag);
      return result instanceof Promise ? pending(result) : undefined;
    }
    if (layers && ['lytween', 'lytweendel', 'tweenset', '/tweenset'].includes(tag.name)) {
      layers.dispatchTween(tag, recordHistory);
      return;
    }
    if (owners.fullscreenVideo.accepts(tag)) return pending(owners.fullscreenVideo.dispatch(tag));
    if (layers?.accepts(tag)) return pending(layers.dispatch(tag, recordHistory));
    if (
      owners.messageSelection?.dispatch(tag) ||
      owners.fontStack?.dispatch(tag, recordHistory) ||
      owners.sceneTweens?.dispatch(tag) ||
      owners.textBreakControls?.dispatch(tag, recordHistory) ||
      owners.dialog.dispatch(tag) ||
      owners.http?.dispatch(tag) ||
      owners.keyBindings.dispatch(tag) ||
      owners.eventCommands.dispatch(tag) ||
      owners.nativeLibrary.dispatch(tag) ||
      owners.textControls.dispatch(tag) ||
      owners.modes.dispatch(tag) ||
      owners.exec.dispatch(tag)
    )
      return;
    const variable = owners.variables.dispatch(tag);
    if (variable instanceof Promise) return pending(variable);
    if (
      variable ||
      owners.caption.dispatch(tag) ||
      owners.seStop.dispatch(tag, recordHistory) ||
      owners.seAdjust.dispatch(tag, recordHistory) ||
      owners.soundFinish?.dispatch(tag) ||
      owners.mouse.dispatch(tag) ||
      owners.wait.dispatch(tag) ||
      owners.stop.dispatch(tag)
    )
      return;
    if (owners.shaders && tag.name === 'lyshader') return pending(owners.shaders.dispatch(tag));
    if (owners.reset.dispatch(tag) || owners.save.dispatch(tag) || owners.exit.dispatch(tag))
      return;
    if (tag.name === 'load') return pending(owners.load.dispatch(tag));
    if (owners.clickGlyphs.dispatch(tag)) return;
    if (owners.music) {
      const result = owners.music.dispatch(tag, recordHistory);
      if (result === true) return;
      if (result) return pending(result);
    }
    if (owners.sePlay && (tag.name === 'seplay' || tag.name === 'sefadein'))
      return pending(owners.sePlay.dispatch(tag, recordHistory));
    if (owners.screenshots) {
      const result = owners.screenshots.dispatch(tag);
      if (result === true) return;
      if (result) return pending(result);
    }
    if (owners.fileCommands) {
      const result = owners.fileCommands.dispatch(tag);
      if (result === true) return;
      if (result) return pending(result);
    }
    throw new Error(`Unsupported native Artemis tag ${tag.name}`);
  };
}
