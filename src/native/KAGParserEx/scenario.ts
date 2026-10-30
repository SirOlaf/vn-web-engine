/**
 * `tTVPScenarioCacheItem` and the scenario cache of KAGParserEx.
 *
 * A scenario is the text up to its first NUL character, split into lines at CR, LF and CR LF.
 * Leading tabs of every line are skipped, and a last line of tabs alone is not a line. As
 * natively, the line terminators are replaced by NUL in one buffer, so a parser that reads
 * past the end of a line reads the next one (`ScenarioItem.buffer`, `lineStart`).
 *
 * Labels are lines of at least two characters starting with `*`. A label's name ends at `|`
 * (the page name follows); `*` alone (or `*|page`) repeats the previous label. A label name
 * that occurs again is registered as `name:2`, `name:3`… .
 */
import {type TvpFunctionExporter} from '../tvp-plugin/contract.js';

const CR = 13;
const LF = 10;
const TAB = 9;

export interface LabelCacheData {
  line: number;
  count: number;
}

export class ScenarioItem {
  /** The text with each line terminator replaced by NUL. */
  readonly buffer: string;
  readonly #starts: number[];
  readonly #lengths: number[];
  readonly lineCount: number;
  readonly labelCache = new Map<string, LabelCacheData>();
  #aliases: string[] = [];
  #labelCached = false;

  private constructor(buffer: string, starts: number[], lengths: number[]) {
    this.buffer = buffer;
    this.#starts = starts;
    this.#lengths = lengths;
    this.lineCount = starts.length;
  }

  /** `tTVPScenarioCacheItem::LoadScenario`; `name` is the storage name (or the text). */
  static load(ex: TvpFunctionExporter, name: string, text: string): ScenarioItem {
    const nul = text.indexOf('\0');
    const t = nul >= 0 ? text.slice(0, nul) : text;
    const n = t.length;
    // pass 1: count lines
    let count = 0;
    let ls = 0;
    let p = 0;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CR || c === LF) {
        count++;
        if (c === CR && t.charCodeAt(p + 1) === LF) p++;
        p++;
        ls = p;
      } else {
        p++;
      }
    }
    if (p !== ls) count++;
    if (count === 0) ex.TVPThrowExceptionMessage(ex.TJSGetMessageMapMessage('TVPKAGNoLine'), name);

    // pass 2: split lines
    const starts: number[] = [];
    const lengths: number[] = [];
    const terminators: number[] = [];
    ls = 0;
    while (ls < n && t.charCodeAt(ls) === TAB) ls++;
    p = ls;
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === CR || c === LF) {
        starts.push(ls);
        lengths.push(p - ls);
        terminators.push(p);
        if (c === CR && t.charCodeAt(p + 1) === LF) p++;
        p++;
        ls = p;
        while (ls < n && t.charCodeAt(ls) === TAB) ls++;
        p = ls;
      } else {
        p++;
      }
    }
    if (p !== ls) {
      starts.push(ls);
      lengths.push(p - ls);
    }
    let buffer = '';
    let from = 0;
    for (const at of terminators) {
      buffer += t.slice(from, at) + '\0';
      from = at + 1;
    }
    buffer += t.slice(from);
    return new ScenarioItem(buffer, starts, lengths);
  }

  /**
   * Where line `i` starts in `buffer`. A text of tabs alone has no lines; its first line reads
   * as the empty string.
   */
  lineStart(i: number): number {
    return this.#starts[i] ?? this.buffer.length;
  }

  /** `Lines[i].Start` as a string. */
  line(i: number): string {
    const start = this.#starts[i];
    return start === undefined ? '' : this.buffer.substr(start, this.#lengths[i]!);
  }

  /** `GetLabelAliasFromLine`: the label registered for a label line (empty for other lines). */
  labelAlias(i: number): string {
    return this.#aliases[i] ?? '';
  }

  /** `EnsureLabelCache`. */
  ensureLabelCache(ex: TvpFunctionExporter): void {
    if (this.#labelCached) return;
    this.#aliases = new Array<string>(this.lineCount).fill('');
    let prevlabel = '';
    for (let i = 0; i < this.lineCount; i++) {
      const line = this.line(i);
      if (line.length < 2 || line[0] !== '*') continue;
      const vl = line.indexOf('|');
      let label = vl >= 0 ? line.slice(0, vl) : line;
      if (label.length < 2) {
        if (prevlabel === '')
          ex.TVPThrowExceptionMessage(
            ex.TJSGetMessageMapMessage('TVPKAGCannotOmmitFirstLabelName'),
          );
        label = prevlabel;
      }
      prevlabel = label;
      const data = this.labelCache.get(label);
      if (data) {
        // duplicated label
        data.count++;
        label = `${label}:${data.count}`;
      }
      this.labelCache.set(label, {line: i, count: 1});
      this.#aliases[i] = label;
    }
    this.#labelCached = true;
  }
}

/** `TVP_SCENARIO_MAX_CACHE_SIZE`. */
const MAX_CACHE_SIZE = 8;

/**
 * `tTVPScenarioCache`: the eight most recently used storages by name. Scenarios that
 * `onScenarioLoad` returns as text are not cached.
 */
export class ScenarioCache {
  /** In use order, least recent first. */
  readonly #items = new Map<string, ScenarioItem>();

  /** `FindAndTouchWithHash`. */
  find(name: string): ScenarioItem | undefined {
    const item = this.#items.get(name);
    if (item) {
      this.#items.delete(name);
      this.#items.set(name, item);
    }
    return item;
  }

  /** `AddWithHash`: drops the least recently used entries beyond the limit. */
  add(name: string, item: ScenarioItem): void {
    this.#items.delete(name);
    this.#items.set(name, item);
    for (const key of this.#items.keys()) {
      if (this.#items.size <= MAX_CACHE_SIZE) break;
      this.#items.delete(key);
    }
  }

  clear(): void {
    this.#items.clear();
  }
}
