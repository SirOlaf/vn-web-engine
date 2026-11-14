/**
 * `Date` (krkrz `tjsDate.cpp`, `tjsDateParser.cpp`, `syntax/tjsdate.y`,
 * `syntax/dp_wordtable.txt`). A date is a `time_t` (seconds); the fields come from the C
 * runtime's `localtime` and `mktime` in the host's time zone, as the Visual C++ runtime computes
 * them: `TJS_timezone` is the standard-time offset, a `tm` with `tm_isdst > 0` is shifted by
 * the one-hour DST bias, and `mktime` fails before 1970 and after 3000.
 */
import {throwTjsError} from '../errors.js';
import {
  TJS_E_BADPARAMCOUNT,
  TJS_E_NATIVECLASSCRASH,
  TJS_S_OK,
  type Dispatch,
} from '../interface.js';
import {constructNativeInstance, NativeClass, NativeInstanceBase, paramExists} from '../native.js';
import {asInteger, asString, int, integer} from '../variant.js';

/** `struct tm` fields used here. */
interface Tm {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
  wday: number;
  /** `tm_isdst`: 1 in daylight saving time. */
  isdst: number;
}

/** The host time zone as the C runtime sees it. */
export interface CrtTimeZone {
  /** `_timezone`: seconds west of UTC in standard time. */
  readonly timezone: number;
  /** `localtime`. */
  localtime(t: number): Tm;
}

/** The host's zone through JavaScript `Date`: DST where the offset is below the standard one. */
export const HOST_TIME_ZONE: CrtTimeZone = (() => {
  const year = new Date().getFullYear();
  const standardMinutes = Math.max(
    new Date(year, 0, 1).getTimezoneOffset(),
    new Date(year, 6, 1).getTimezoneOffset(),
  );
  return {
    timezone: standardMinutes * 60,
    localtime(t: number): Tm {
      const d = new Date(t * 1000);
      return {
        year: d.getFullYear() - 1900,
        mon: d.getMonth(),
        mday: d.getDate(),
        hour: d.getHours(),
        min: d.getMinutes(),
        sec: d.getSeconds(),
        wday: d.getDay(),
        isdst: d.getTimezoneOffset() < standardMinutes ? 1 : 0,
      };
    },
  };
})();

/** `_mktime64`'s range: 1970-01-01 00:00:00 to 3000-12-31 23:59:59 UTC. */
const MKTIME_MAX = 32535215999;

/** `mktime`: fields (normalized) as local time; -1 outside the supported range. */
export function mktime(tm: Tm, zone: CrtTimeZone): number {
  const d = new Date(0);
  d.setUTCFullYear(tm.year + 1900, tm.mon, tm.mday);
  d.setUTCHours(tm.hour, tm.min, tm.sec, 0);
  let t = d.getTime() / 1000 + zone.timezone;
  if (tm.isdst > 0) t -= 3600;
  if (!Number.isFinite(t) || t < 0 || t > MKTIME_MAX) return -1;
  return t;
}

// --- date strings -----------------------------------------------------------------------

const enum Tok {
  Number = 1,
  Month,
  Wday,
  Tz,
  Am,
  Pm,
}

/** `dp_wordtable.txt`: word → token and value. Longer words are tried first. */
const WORDS: readonly (readonly [string, Tok, number])[] = (() => {
  const tz =
    'jst:900 ut:0 utc:0 gmt:0 est:-500 edt:-400 cst:-600 cdt:-500 mst:-700 mdt:-600 pst:-800 ' +
    'pdt:-700 z:0 a:-100 m:-1200 n:100 y:1200 nzdt:1300 idle:1200 nzst:1200 nzt:1200 ' +
    'aesst:1100 acsst:1030 cadt:1030 sadt:1030 aest:1000 east:1000 gst:1000 ligt:1000 ' +
    'acst:930 sast:930 cast:930 awsst:900 kst:900 wdt:900 mt:830 awst:800 cct:800 wadt:800 ' +
    'wst:800 jt:730 wast:700 it:330 bt:300 eetdst:300 cetdst:200 eet:200 fwt:200 ist:200 ' +
    'mest:200 metdst:200 sst:200 bst:100 cet:100 dnt:100 fst:100 met:100 mewt:100 mez:100 ' +
    'nor:100 set:100 swt:100 wetdst:100 wet:0 wat:-100 ndt:-230 adt:-300 nft:-330 nst:-330 ' +
    'ast:-400 ydt:-800 hdt:-900 ahst:-1000 cat:-1000 nt:-1100 idlw:-1200';
  const wday =
    'sun sun. sunday|mon mon. monday|tue tue. tues tues. tuesday|wed wed. wednesday|' +
    'thu thu. thurs thurs. thursday|fri fri. friday|sat sat. saturday';
  const month =
    'jan jan. january|feb feb. february|mar mar. march|apr apr. april|may|' +
    'ju ju. jun jun. june|jul jul. july|aug aug. august|sep sep. sept sept. september|' +
    'oct oct. october|nov nov. november|dec dec. december';
  const out: [string, Tok, number][] = [];
  for (const e of tz.split(' ')) {
    const [w, v] = e.split(':');
    out.push([w!, Tok.Tz, +v!]);
  }
  wday.split('|').forEach((g, i) => g.split(' ').forEach((w) => out.push([w, Tok.Wday, i])));
  month.split('|').forEach((g, i) => g.split(' ').forEach((w) => out.push([w, Tok.Month, i])));
  out.push(['am', Tok.Am, 0], ['pm', Tok.Pm, 0]);
  return out.sort((a, b) => b[0].length - a[0].length);
})();

/** `TJS_iswalpha`: non-Latin-1 counts as alphabetic. */
function isAlpha(c: number): boolean {
  if (Number.isNaN(c)) return false;
  if (c & 0xff00) return true;
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** A token: a word or number token with its value, or a character (lower-cased). */
type Token = {tok: Tok; val: number} | {ch: string};

/** `tTJSDateParser::Lex` over the whole input; `(` skips to the next `)`. */
function lex(input: string): Token[] {
  const out: Token[] = [];
  let p = 0;
  const lower = input.toLowerCase();
  const isSpace = (c: number) => (c >= 0x09 && c <= 0x0d) || c === 0x20;
  while (p < input.length) {
    while (p < input.length && isSpace(input.charCodeAt(p))) p++;
    if (p >= input.length) break;
    const c = input.charCodeAt(p);
    if (c >= 0x30 && c <= 0x39) {
      let val = 0;
      while (p < input.length && input.charCodeAt(p) >= 0x30 && input.charCodeAt(p) <= 0x39)
        val = (val * 10 + input.charCodeAt(p++) - 0x30) | 0;
      out.push({tok: Tok.Number, val});
      continue;
    }
    const word = WORDS.find(
      ([w]) => lower.startsWith(w, p) && !isAlpha(input.charCodeAt(p + w.length)),
    );
    if (word) {
      out.push({tok: word[1], val: word[2]});
      p += word[0].length;
      continue;
    }
    const ch = String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    out.push({ch});
    p++;
    if (ch === '(') while (p < input.length && input[p] !== ')') p++;
  }
  return out;
}

interface Fields {
  year?: number;
  month?: number;
  mday?: number;
  hour?: number;
  min?: number;
  sec?: number;
  pm?: boolean;
  tz?: number;
  tzOffset?: number;
}

/** The grammar of `tjsdate.y` as a backtracking parser; fields are set on success only. */
class DateGrammar {
  #i = 0;
  constructor(private readonly toks: readonly Token[]) {}

  parse(): Fields | null {
    for (const alt of this.#alternatives()) {
      this.#i = 0;
      const f: Fields = {};
      if (alt(f) && this.#i === this.toks.length) return f;
    }
    return null;
  }

  #num(): number | null {
    const t = this.toks[this.#i];
    if (t && 'tok' in t && t.tok === Tok.Number) return (this.#i++, t.val);
    return null;
  }
  #tok(tok: Tok): number | null {
    const t = this.toks[this.#i];
    if (t && 'tok' in t && t.tok === tok) return (this.#i++, t.val);
    return null;
  }
  #ch(ch: string): boolean {
    const t = this.toks[this.#i];
    if (t && 'ch' in t && t.ch === ch) return (this.#i++, true);
    return false;
  }
  /** Tries `f`; restores the position when it fails. */
  #opt(f: () => boolean): boolean {
    const save = this.#i;
    if (f()) return true;
    this.#i = save;
    return false;
  }

  #wdayOmittable(): void {
    if (this.#tok(Tok.Wday) !== null) this.#ch(',');
  }
  #month(f: Fields): boolean {
    const m = this.#tok(Tok.Month);
    if (m === null) return false;
    f.month = m;
    return true;
  }
  #timeHms(f: Fields): boolean {
    const h = this.#num();
    if (h === null || !this.#ch(':')) return false;
    const m = this.#num();
    if (m === null) return false;
    const save = this.#i;
    if (this.#ch(':')) {
      const s = this.#num();
      if (s !== null) {
        this.#opt(() => this.#ch('.') && this.#num() !== null);
        Object.assign(f, {hour: h, min: m, sec: s});
        return true;
      }
      this.#i = save;
    }
    Object.assign(f, {hour: h, min: m, sec: 0});
    return true;
  }
  #ampm(f: Fields): boolean {
    if (this.#tok(Tok.Am) !== null) return ((f.pm = false), true);
    if (this.#tok(Tok.Pm) !== null) return ((f.pm = true), true);
    return false;
  }
  #time(f: Fields): boolean {
    if (this.#opt(() => this.#ampm(f) && this.#timeHms(f))) return true;
    if (!this.#timeHms(f)) return false;
    this.#opt(() => this.#ampm(f));
    return true;
  }
  #tzOmittable(f: Fields): void {
    const tz = this.#tok(Tok.Tz);
    if (tz !== null) f.tz = tz;
    this.#opt(() => {
      const sign = this.#ch('+') ? 1 : this.#ch('-') ? -1 : 0;
      const n = sign ? this.#num() : null;
      if (n === null) return false;
      f.tzOffset = sign * n;
      return true;
    });
    this.#opt(() => this.#ch('(') && this.#ch(')'));
  }
  #year(f: Fields, v: number | null): boolean {
    if (v === null) return false;
    f.year = v < 100 ? (v <= 50 ? 2000 + v : 1900 + v) : v;
    return true;
  }

  #alternatives(): ((f: Fields) => boolean)[] {
    const w = () => (this.#wdayOmittable(), true);
    const n = () => this.#num();
    const c = (ch: string) => this.#ch(ch);
    const tail = (f: Fields) => (this.#tzOmittable(f), true);
    const set = (f: Fields, mday: number | null, year: number | null) =>
      mday !== null && ((f.mday = mday), this.#year(f, year));
    return [
      // Sun, 3 May 2004 11:22:33 GMT +900 (JST)
      (f) => {
        w();
        const d = n();
        return this.#month(f) && set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, 3-May 2004 …
      (f) => {
        w();
        const d = n();
        return c('-') && this.#month(f) && set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, 3-May-2004 …
      (f) => {
        w();
        const d = n();
        return c('-') && this.#month(f) && c('-') && set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, May 3 2004 …
      (f) => {
        w();
        if (!this.#month(f)) return false;
        const d = n();
        return set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, May-3 2004 …
      (f) => {
        w();
        if (!this.#month(f) || !c('-')) return false;
        const d = n();
        return set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, May-3-2004 …
      (f) => {
        w();
        if (!this.#month(f) || !c('-')) return false;
        const d = n();
        return d !== null && c('-') && set(f, d, n()) && this.#time(f) && tail(f);
      },
      // Sun, 3 May 11:22:33 2004 …
      (f) => {
        w();
        const d = n();
        return d !== null && this.#month(f) && this.#time(f) && set(f, d, n()) && tail(f);
      },
      // Sun, 3-May 11:22:33 2004 …
      (f) => {
        w();
        const d = n();
        return d !== null && c('-') && this.#month(f) && this.#time(f) && set(f, d, n()) && tail(f);
      },
      // Sun, May 3 11:22:33 2004 …
      (f) => {
        w();
        if (!this.#month(f)) return false;
        const d = n();
        return d !== null && this.#time(f) && set(f, d, n()) && tail(f);
      },
      // Sun, May-3 11:22:33 2004 …
      (f) => {
        w();
        if (!this.#month(f) || !c('-')) return false;
        const d = n();
        return d !== null && this.#time(f) && set(f, d, n()) && tail(f);
      },
      // 2004/03/03 11:22:33
      (f) => {
        w();
        const y = n();
        if (y === null || !(c('-') || c('/'))) return false;
        const m = n();
        if (m === null || !(c('-') || c('/'))) return false;
        f.month = m - 1;
        return set(f, n(), y) && this.#time(f) && tail(f);
      },
    ];
  }
}

/** `[+/-]hhmm` as seconds. */
function zoneSeconds(v: number): number {
  const a = Math.abs(v);
  const s = Math.trunc(a / 100) * 3600 + (a % 100) * 60;
  return v < 0 ? -s : s;
}

/** `TJSParseDateString`: seconds since 1970 UTC. */
export function parseDateString(text: string, zone: CrtTimeZone): number {
  const f = new DateGrammar(lex(text)).parse();
  if (
    !f ||
    f.year === undefined ||
    f.month === undefined ||
    f.mday === undefined ||
    f.hour === undefined ||
    f.min === undefined
  )
    throwTjsError('TJSCannotParseDate');
  let hour = f.hour;
  if (f.pm) hour += 12;
  let tz = 0;
  if (f.tz === undefined && f.tzOffset === undefined) tz = -zone.timezone;
  else {
    if (f.tz !== undefined) tz += zoneSeconds(f.tz);
    if (f.tzOffset !== undefined) tz += zoneSeconds(f.tzOffset);
  }
  const tmv = mktime(
    {
      year: f.year - 1900,
      mon: f.month,
      mday: f.mday,
      hour,
      min: f.min,
      sec: f.sec ?? 0,
      wday: 0,
      isdst: 0,
    },
    zone,
  );
  if (tmv === -1) throwTjsError('TJSInvalidValueForTimestamp');
  return tmv - zone.timezone - tz;
}

// --- the class ----------------------------------------------------------------------------

/** `tTJSNI_Date`. */
class DateNI extends NativeInstanceBase {
  dateTime = 0;
}

export class DateClass extends NativeClass {
  constructor(now: () => number, zone: CrtTimeZone = HOST_TIME_ZONE) {
    super('Date', () => new DateNI());
    const self = this;
    const get = (objthis: Dispatch) => self.instanceOf<DateNI>(objthis);
    const check = (t: number) => {
      if (t === -1) throwTjsError('TJSInvalidValueForTimestamp');
      return t;
    };
    this.emptyFinalize();
    this.constructorMethod((_result, args, objthis) => {
      const ni = constructNativeInstance<DateNI>(self, args, objthis);
      if (typeof ni === 'number') return ni;
      if (args.length === 0) ni.dateTime = now();
      else if (args[0]!.type === 2) ni.dateTime = parseDateString(args[0]!.value, zone);
      else {
        const field = (i: number, d: number) =>
          paramExists(args, i) ? Number(BigInt.asIntN(32, asInteger(args[i]!))) : d;
        const tm: Tm = {
          year: field(0, 0) - 1900,
          mon: field(1, 0),
          mday: field(2, 1),
          hour: field(3, 0),
          min: field(4, 0),
          sec: field(5, 0),
          wday: 0,
          isdst: 0,
        };
        ni.dateTime = check(mktime(tm, zone));
      }
      return TJS_S_OK;
    });
    const setter = (name: string, key: keyof Tm, offset = 0) =>
      this.method(name, (_result, args, objthis) => {
        const ni = get(objthis);
        if (!ni) return TJS_E_NATIVECLASSCRASH;
        if (args.length < 1) return TJS_E_BADPARAMCOUNT;
        const tm = zone.localtime(ni.dateTime);
        tm[key] = Number(BigInt.asIntN(32, asInteger(args[0]!))) - offset;
        ni.dateTime = check(mktime(tm, zone));
        return TJS_S_OK;
      });
    setter('setYear', 'year', 1900);
    setter('setMonth', 'mon');
    setter('setDate', 'mday');
    setter('setHours', 'hour');
    setter('setMinutes', 'min');
    setter('setSeconds', 'sec');
    this.method('setTime', (_result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      ni.dateTime = Number(asInteger(args[0]!) / 1000n);
      return TJS_S_OK;
    });
    const getter = (name: string, read: (tm: Tm) => number) =>
      this.method(name, (result, _args, objthis) => {
        const ni = get(objthis);
        if (!ni) return TJS_E_NATIVECLASSCRASH;
        const tm = zone.localtime(ni.dateTime);
        result?.set(int(read(tm)));
        return TJS_S_OK;
      });
    getter('getDate', (t) => t.mday);
    getter('getDay', (t) => t.wday);
    getter('getHours', (t) => t.hour);
    getter('getMinutes', (t) => t.min);
    getter('getMonth', (t) => t.mon);
    getter('getSeconds', (t) => t.sec);
    this.method('getTime', (result, _args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      result?.set(integer(BigInt(ni.dateTime) * 1000n));
      return TJS_S_OK;
    });
    this.method('getTimezoneOffset', (result) => {
      result?.set(int(Math.trunc(zone.timezone / 60)));
      return TJS_S_OK;
    });
    getter('getYear', (t) => t.year + 1900);
    this.method('parse', (_result, args, objthis) => {
      const ni = get(objthis);
      if (!ni) return TJS_E_NATIVECLASSCRASH;
      if (args.length < 1) return TJS_E_BADPARAMCOUNT;
      ni.dateTime = parseDateString(asString(args[0]!), zone);
      return TJS_S_OK;
    });
  }
}
