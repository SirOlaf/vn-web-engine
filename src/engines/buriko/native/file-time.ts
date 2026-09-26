import {pointerView, type BurikoBpPointer} from '../bp/memory.js';

const millisecondsPerDay = 86400000n;
const ticksPerMillisecond = 10000n;
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function daysBeforeYear(year: number): number {
  const preceding = year - 1;
  return (
    preceding * 365 +
    Math.floor(preceding / 4) -
    Math.floor(preceding / 100) +
    Math.floor(preceding / 400)
  );
}
const epochDays = daysBeforeYear(1601);
function daysInMonth(year: number, month: number): number {
  return monthDays[month - 1]! + Number(month === 2 && leap(year));
}

/** SYSTEMTIME -> FILETIME is UTC Gregorian arithmetic; wDayOfWeek is ignored.
 * This title-local Windows primitive uses the documented 1601..30827 input profile. */
export function burikoSystemTimeToFileTime(input: BurikoBpPointer): bigint | null {
  const value = pointerView(input, 16),
    year = value.getUint16(0, true),
    month = value.getUint16(2, true),
    day = value.getUint16(6, true),
    hour = value.getUint16(8, true),
    minute = value.getUint16(10, true),
    second = value.getUint16(12, true),
    millisecond = value.getUint16(14, true);
  if (
    year < 1601 ||
    year > 30827 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    millisecond > 999
  )
    return null;
  let days = daysBeforeYear(year) - epochDays + day - 1;
  for (let previous = 1; previous < month; previous++) days += daysInMonth(year, previous);
  return (
    (BigInt(days) * millisecondsPerDay +
      BigInt(((hour * 60 + minute) * 60 + second) * 1000 + millisecond)) *
    ticksPerMillisecond
  );
}

/** FILETIME -> SYSTEMTIME retains millisecond truncation and Sunday=0.
 * A high sign bit causes the native conversion to fail without producing an output record. */
export function burikoFileTimeToSystemTime(time: bigint): Uint16Array | null {
  time = BigInt.asUintN(64, time);
  if (time >= 0x8000000000000000n) return null;
  const milliseconds = time / ticksPerMillisecond,
    dayCount = Number(milliseconds / millisecondsPerDay);
  let lower = 1601,
    upper = 65536;
  while (lower + 1 < upper) {
    const middle = (lower + upper) >>> 1;
    if (daysBeforeYear(middle) - epochDays <= dayCount) lower = middle;
    else upper = middle;
  }
  const year = lower;
  let remaining = dayCount - (daysBeforeYear(year) - epochDays),
    month = 1;
  while (remaining >= daysInMonth(year, month)) {
    remaining -= daysInMonth(year, month);
    month++;
  }
  const within = Number(milliseconds % millisecondsPerDay),
    hour = Math.floor(within / 3600000),
    minute = Math.floor(within / 60000) % 60,
    second = Math.floor(within / 1000) % 60,
    millisecond = within % 1000;
  return Uint16Array.of(
    year,
    month,
    (dayCount + 1) % 7,
    remaining + 1,
    hour,
    minute,
    second,
    millisecond,
  );
}

export function writeBurikoSystemTime(output: BurikoBpPointer, time: bigint): boolean {
  const fields = burikoFileTimeToSystemTime(time);
  if (fields === null) return false;
  for (let index = 0; index < 8; index++)
    pointerView({bytes: output.bytes, offset: output.offset + index * 2}, 2).setUint16(
      0,
      fields[index]!,
      true,
    );
  return true;
}
