import type {Lua51, LuaValue} from '../../core/lua51/runtime.js';

/** The Lua 5.1.5 `os` library as the native CLua constructor opens it (0x14012a720, Rev.3139
 * 0x1401293e0: luaL_openlibs over base, package, table, io, os, string, math and debug;
 * luaopen_os 0x1401b53a0 / 0x1401b3d40) over the MSVC UCRT, in the browser.
 *
 * `date`, `time` and `difftime` follow loslib.c with UCRT `_localtime64`/`_gmtime64`,
 * `_mktime64` and `strftime` in the "C" locale; the local time zone is the browser's.
 * `execute` without a command asks `system(NULL)` whether a command interpreter exists:
 * the browser has none, so it returns 0 (UCRT: no interpreter found). Every other use
 * (running a command, `exit`, `getenv`, `clock`, files, `setlocale`) is refused explicitly.
 */

/** Seconds since the epoch accepted here: UCRT's `_localtime64` range (to 3000-12-31) with
 * a day of margin at both ends so that no time zone moves a value outside it. */
const firstSecond = 86400,
  lastSecond = 32535215999 - 86400;

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export class ArtemisLuaOsUnsupported extends Error {}

/** Platform services behind the library (src/platform: WindowsCommandInterpreterHost,
 * the system profile's environment). */
export interface ArtemisLuaOsHost {
  /** CRT `system`. */
  system(command: Uint8Array | null): number;
  /** CRT `getenv`; null when the variable is not set. */
  getenv(name: Uint8Array): Uint8Array | null;
}

interface Calendar {
  readonly year: number;
  /** 0-11. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0-6, Sunday first. */
  readonly weekday: number;
  /** 0-365. */
  readonly yearDay: number;
  readonly dst: boolean;
  /** Minutes east of UTC. */
  readonly offset: number;
}

function calendar(seconds: number, utc: boolean): Calendar {
  const date = new Date(seconds * 1000);
  const year = utc ? date.getUTCFullYear() : date.getFullYear(),
    month = utc ? date.getUTCMonth() : date.getMonth(),
    day = utc ? date.getUTCDate() : date.getDate();
  const offset = utc ? 0 : -date.getTimezoneOffset();
  const january = -new Date(year, 0, 1).getTimezoneOffset(),
    july = -new Date(year, 6, 1).getTimezoneOffset();
  return {
    year,
    month,
    day,
    hour: utc ? date.getUTCHours() : date.getHours(),
    minute: utc ? date.getUTCMinutes() : date.getMinutes(),
    second: utc ? date.getUTCSeconds() : date.getSeconds(),
    weekday: utc ? date.getUTCDay() : date.getDay(),
    yearDay: Math.round((Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86400000),
    dst: !utc && january !== july && offset === Math.max(january, july),
    offset,
  };
}

/** `(time_t)luaL_checknumber`: truncation of the Lua number. */
function timeValue(value: number): number {
  if (!Number.isFinite(value)) throw new ArtemisLuaOsUnsupported('Unsupported Artemis os time');
  return Math.trunc(value);
}

const pad = (value: number, width = 2, fill = '0') => String(value).padStart(width, fill);

/** ISO 8601 week-based year and week of `c` (UCRT %G/%g/%V). */
function isoWeek(c: Calendar): {year: number; week: number} {
  const weekday = (c.weekday + 6) % 7; // Monday 0.
  const thursday = c.yearDay - weekday + 3;
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (thursday < 0) {
    const previous = c.year - 1,
      days = leap(previous) ? 366 : 365;
    return {year: previous, week: Math.floor((thursday + days) / 7) + 1};
  }
  const days = leap(c.year) ? 366 : 365;
  if (thursday >= days) return {year: c.year + 1, week: 1};
  return {year: c.year, week: Math.floor(thursday / 7) + 1};
}

/** One UCRT strftime conversion `%c` in the "C" locale. Conversions whose "C" locale text
 * is not established here (%c, %x, %X, %Z) and invalid ones (which raise the UCRT invalid
 * parameter handler) are refused. */
function convert(conversion: string, c: Calendar): string {
  const hour12 = c.hour % 12 || 12;
  switch (conversion) {
    case 'a':
      return weekdays[c.weekday]!.slice(0, 3);
    case 'A':
      return weekdays[c.weekday]!;
    case 'b':
    case 'h':
      return months[c.month]!.slice(0, 3);
    case 'B':
      return months[c.month]!;
    case 'C':
      return pad(Math.floor(c.year / 100));
    case 'd':
      return pad(c.day);
    case 'D':
      return `${pad(c.month + 1)}/${pad(c.day)}/${pad(c.year % 100)}`;
    case 'e':
      return pad(c.day, 2, ' ');
    case 'F':
      return `${c.year}-${pad(c.month + 1)}-${pad(c.day)}`;
    case 'g':
      return pad(isoWeek(c).year % 100);
    case 'G':
      return String(isoWeek(c).year);
    case 'H':
      return pad(c.hour);
    case 'I':
      return pad(hour12);
    case 'j':
      return pad(c.yearDay + 1, 3);
    case 'm':
      return pad(c.month + 1);
    case 'M':
      return pad(c.minute);
    case 'n':
      return '\n';
    case 'p':
      return c.hour < 12 ? 'AM' : 'PM';
    case 'r':
      return `${pad(hour12)}:${pad(c.minute)}:${pad(c.second)} ${c.hour < 12 ? 'AM' : 'PM'}`;
    case 'R':
      return `${pad(c.hour)}:${pad(c.minute)}`;
    case 'S':
      return pad(c.second);
    case 't':
      return '\t';
    case 'T':
      return `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}`;
    case 'u':
      return String(c.weekday || 7);
    case 'U':
      return pad(Math.floor((c.yearDay + 7 - c.weekday) / 7));
    case 'V':
      return pad(isoWeek(c).week);
    case 'w':
      return String(c.weekday);
    case 'W':
      return pad(Math.floor((c.yearDay + 7 - ((c.weekday + 6) % 7)) / 7));
    case 'y':
      return pad(c.year % 100);
    case 'Y':
      return String(c.year);
    case 'z': {
      const minutes = Math.abs(c.offset);
      return `${c.offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}${pad(minutes % 60)}`;
    }
    case '%':
      return '%';
    default:
      throw new ArtemisLuaOsUnsupported(`Unsupported Artemis os.date conversion %${conversion}`);
  }
}

export type ArtemisOsDate = Uint8Array | Map<string, number | boolean> | null;

/** loslib os_date: `format` (already luaL_optstring, default "%c") and the time in seconds
 * (already luaL_checknumber; undefined is `time(NULL)`). A leading '!' selects UTC; "*t"
 * returns the fields table. Each '%' takes the next byte as one strftime conversion; a
 * trailing '%' is literal. null is a failed conversion of the time (Lua nil). */
export function artemisOsDate(
  format: Uint8Array,
  time: number | undefined,
  now: () => number,
): ArtemisOsDate {
  const seconds = time === undefined ? Math.floor(now() / 1000) : timeValue(time);
  // luaL_optstring yields a C string: the format ends at its first NUL.
  const nul = format.indexOf(0);
  let bytes = nul < 0 ? format : format.subarray(0, nul);
  const utc = bytes[0] === 0x21;
  if (utc) bytes = bytes.subarray(1);
  if (seconds < firstSecond || seconds > lastSecond)
    throw new ArtemisLuaOsUnsupported('Unsupported Artemis os.date time outside UCRT range');
  const c = calendar(seconds, utc);
  if (bytes.length === 2 && bytes[0] === 0x2a && bytes[1] === 0x74)
    return new Map<string, number | boolean>([
      ['sec', c.second],
      ['min', c.minute],
      ['hour', c.hour],
      ['day', c.day],
      ['month', c.month + 1],
      ['year', c.year],
      ['wday', c.weekday + 1],
      ['yday', c.yearDay + 1],
      ['isdst', c.dst],
    ]);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x25 || i + 1 === bytes.length) {
      out.push(bytes[i]!);
      continue;
    }
    const conversion = bytes[++i]!;
    if (conversion >= 0x80)
      throw new ArtemisLuaOsUnsupported('Unsupported Artemis os.date conversion');
    for (const char of convert(String.fromCharCode(conversion), c)) out.push(char.charCodeAt(0));
  }
  return Uint8Array.from(out);
}

/** The date table fields loslib os_time reads (getfield: lua_isnumber, then
 * `(int)lua_tointeger`; missing day, month or year is a Lua error raised by the caller). */
export interface ArtemisOsTimeFields {
  readonly sec: number;
  readonly min: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly year: number;
  /** getboolfield: undefined for nil. */
  readonly isdst: boolean | undefined;
}

/** loslib os_time: `time(NULL)` without fields, else `_mktime64` of the local calendar
 * fields (normalized like mktime). null is mktime's -1 (Lua nil). An explicit `isdst` asks
 * for a daylight-saving bias the browser time zone does not expose and is refused. */
export function artemisOsTime(
  fields: ArtemisOsTimeFields | undefined,
  now: () => number,
): number | null {
  if (!fields) return Math.floor(now() / 1000);
  if (fields.isdst !== undefined)
    throw new ArtemisLuaOsUnsupported('Unsupported Artemis os.time isdst field');
  const int = (value: number) => {
    if (!Number.isFinite(value))
      throw new ArtemisLuaOsUnsupported('Unsupported Artemis os.time field');
    return Math.trunc(value) | 0;
  };
  const date = new Date(2000, 0, 1, 0, 0, 0, 0);
  date.setFullYear(int(fields.year), int(fields.month) - 1, int(fields.day));
  date.setHours(int(fields.hour), int(fields.min), int(fields.sec), 0);
  const seconds = date.getTime() / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 32535244799) return null;
  return seconds;
}

/** loslib os_difftime over UCRT `_difftime64`, which rejects negative times. */
export function artemisOsDifftime(t2: number, t1: number): number {
  const a = timeValue(t2),
    b = timeValue(t1);
  if (a < 0 || b < 0)
    throw new ArtemisLuaOsUnsupported('Unsupported Artemis os.difftime of negative time');
  return a - b;
}

const optionalNumber = (value: LuaValue | undefined): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error('Artemis os argument is not a number');
  return value;
};
const requiredNumber = (value: LuaValue | undefined): number => {
  if (typeof value !== 'number') throw new Error('Artemis os argument is not a number');
  return value;
};

/** Installs the global `os` table. Lua checks the arguments like loslib (luaL_opt*,
 * luaL_check*, the date-table getfield) and calls the hidden engine methods, which are
 * removed from the engine table again. `now` is the wall clock in milliseconds. */
export function installArtemisLuaOs(
  vm: Lua51,
  host: ArtemisLuaOsHost | undefined,
  now: () => number,
): void {
  const unsupported = (name: string) => {
    throw new ArtemisLuaOsUnsupported(`Unsupported Artemis Lua os.${name}`);
  };
  vm.bind('artemisOsDate', (args) => {
    if (!(args[0] instanceof Uint8Array)) throw new Error('Artemis os.date format is not a string');
    return [artemisOsDate(args[0], optionalNumber(args[1]), now)];
  });
  vm.bind('artemisOsTime', (args) => {
    if (!args.length) return [artemisOsTime(undefined, now)];
    const [sec, min, hour, day, month, year] = args.slice(0, 6).map(requiredNumber);
    const isdst = args[6];
    return [
      artemisOsTime(
        {
          sec: sec!,
          min: min!,
          hour: hour!,
          day: day!,
          month: month!,
          year: year!,
          isdst: typeof isdst === 'boolean' ? isdst : undefined,
        },
        now,
      ),
    ];
  });
  vm.bind('artemisOsDifftime', (args) => [
    artemisOsDifftime(requiredNumber(args[0]), requiredNumber(args[1])),
  ]);
  vm.bind('artemisOsExecute', (args) => {
    if (!host) return unsupported('execute');
    const command = args[0] instanceof Uint8Array ? args[0] : null;
    const nul = command?.indexOf(0) ?? -1;
    const status = host.system(command && nul >= 0 ? command.subarray(0, nul) : command);
    if (!Number.isInteger(status) || status < -0x80000000 || status > 0x7fffffff)
      throw new Error('Invalid CRT system status');
    return [status];
  });
  vm.bind('artemisOsGetenv', (args) => {
    if (!host) return unsupported('getenv');
    if (!(args[0] instanceof Uint8Array)) throw new Error('Artemis os.getenv name is not a string');
    const nul = args[0].indexOf(0);
    return [host.getenv(nul < 0 ? args[0] : args[0].subarray(0, nul))];
  });
  vm.bind('artemisOsUnsupported', (args) =>
    unsupported(args[0] instanceof Uint8Array ? new TextDecoder().decode(args[0]) : '?'),
  );
  vm.execute(
    new TextEncoder().encode(`
    local engine = engine
    local m = {}
    for _, k in ipairs({'artemisOsDate', 'artemisOsTime', 'artemisOsDifftime',
        'artemisOsExecute', 'artemisOsGetenv', 'artemisOsUnsupported'}) do
      m[k] = engine[k]
      engine[k] = nil
    end
    local select, type, tonumber, tostring, error = select, type, tonumber, tostring, error
    local function argerror(n, name, expected, ...)
      local got = select('#', ...) < n and 'no value' or type((select(n, ...)))
      error("bad argument #" .. n .. " to '" .. name .. "' (" .. expected ..
        " expected, got " .. got .. ")", 0)
    end
    local function checknumber(n, name, ...)
      local value = select(n, ...)
      local number = (type(value) == 'number' or type(value) == 'string') and tonumber(value)
      if not number then argerror(n, name, 'number', ...) end
      return number
    end
    local function optnumber(n, name, default, ...)
      if select(n, ...) == nil then return default end
      return checknumber(n, name, ...)
    end
    local function checkstring(n, name, ...)
      local value = select(n, ...)
      if type(value) == 'number' then return tostring(value) end
      if type(value) ~= 'string' then argerror(n, name, 'string', ...) end
      return value
    end
    local function optstring(n, name, default, ...)
      if select(n, ...) == nil then return default end
      return checkstring(n, name, ...)
    end
    local function refuse(name) return function() return m.artemisOsUnsupported(engine, name) end end
    os = {
      date = function(...)
        return m.artemisOsDate(engine, optstring(1, 'date', '%c', ...), optnumber(2, 'date', nil, ...))
      end,
      time = function(...)
        local t = select(1, ...)
        if t == nil then return m.artemisOsTime(engine) end
        if type(t) ~= 'table' then argerror(1, 'time', 'table', ...) end
        local function field(key, default)
          local value = t[key]
          local number = (type(value) == 'number' or type(value) == 'string') and tonumber(value)
          if number then return number end
          if default < 0 then error("field '" .. key .. "' missing in date table", 0) end
          return default
        end
        local sec, min, hour = field('sec', 0), field('min', 0), field('hour', 12)
        local day, month, year = field('day', -1), field('month', -1), field('year', -1)
        local isdst = t.isdst
        if isdst ~= nil then isdst = not not isdst end
        return m.artemisOsTime(engine, sec, min, hour, day, month, year, isdst)
      end,
      difftime = function(...)
        return m.artemisOsDifftime(engine, checknumber(1, 'difftime', ...),
          optnumber(2, 'difftime', 0, ...))
      end,
      execute = function(...)
        return m.artemisOsExecute(engine, optstring(1, 'execute', nil, ...))
      end,
      getenv = function(...)
        return m.artemisOsGetenv(engine, checkstring(1, 'getenv', ...))
      end,
      setlocale = function(...)
        local locale = optstring(1, 'setlocale', nil, ...)
        local category = optstring(2, 'setlocale', 'all', ...)
        local valid = {all = true, collate = true, ctype = true, monetary = true, numeric = true,
          time = true}
        if not valid[category] then
          error("bad argument #2 to 'setlocale' (invalid option '" .. category .. "')", 0)
        end
        -- The CRT starts in the "C" locale; setting one is a platform locale change.
        if locale == nil then return 'C' end
        return m.artemisOsUnsupported(engine, 'setlocale')
      end,
      clock = refuse('clock'),
      exit = refuse('exit'),
      remove = refuse('remove'),
      rename = refuse('rename'),
      tmpname = refuse('tmpname'),
    }
    `),
    '@artemis/os',
  );
}
