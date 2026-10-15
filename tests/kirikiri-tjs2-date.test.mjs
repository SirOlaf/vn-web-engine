import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DateClass,
  mktime,
  parseDateString,
} from '../dist/engines/kirikiri/tjs2/runtime/builtins/date.js';
import {TjsError} from '../dist/engines/kirikiri/tjs2/runtime/errors.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';

/** Japan: UTC+9, no daylight saving time. */
const JST = {
  timezone: -9 * 3600,
  localtime(t) {
    const d = new Date((t + 9 * 3600) * 1000);
    return {
      year: d.getUTCFullYear() - 1900,
      mon: d.getUTCMonth(),
      mday: d.getUTCDate(),
      hour: d.getUTCHours(),
      min: d.getUTCMinutes(),
      sec: d.getUTCSeconds(),
      wday: d.getUTCDay(),
      isdst: 0,
    };
  },
};
const utc = (...a) => Date.UTC(...a) / 1000;

test('mktime: local fields, normalization, the 1970–3000 range', () => {
  const tm = (year, mon, mday, hour = 0, min = 0, sec = 0) => ({
    year: year - 1900,
    mon,
    mday,
    hour,
    min,
    sec,
    wday: 0,
    isdst: 0,
  });
  assert.equal(mktime(tm(2014, 10, 18, 17, 23, 21), JST), utc(2014, 10, 18, 8, 23, 21));
  assert.equal(mktime(tm(2014, 12, 1), JST), utc(2014, 11, 31, 15), 'month 12 is next January');
  assert.equal(mktime(tm(1970, 0, 1), JST), -1, 'before 1970 in UTC');
  assert.equal(mktime(tm(3001, 0, 2), JST), -1);
});

test('date strings: the tjsdate.y forms, time zones, two-digit years', () => {
  const p = (s) => parseDateString(s, JST);
  assert.equal(p('Sun, 3 May 2004 11:22:33 GMT'), utc(2004, 4, 3, 11, 22, 33));
  assert.equal(p('Sun, 3 May 2004 11:22:33 GMT +0900 (JST)'), utc(2004, 4, 3, 2, 22, 33));
  assert.equal(p('3-May-04 11:22'), utc(2004, 4, 3, 2, 22), 'local time without a zone');
  assert.equal(p('May 3 11:22:33 2004 jst'), utc(2004, 4, 3, 2, 22, 33));
  assert.equal(p('2014/11/18 17:23:21'), utc(2014, 10, 18, 8, 23, 21));
  assert.equal(p('2014-11-18 5:23 pm'), utc(2014, 10, 18, 8, 23));
  assert.equal(p('Tues. Nov. 18 99 1:00:00.5 EST'), utc(1999, 10, 18, 6));
  assert.throws(() => p('2014/11/18'), TjsError, 'the time is required');
  assert.throws(() => p('hello'), TjsError);
});

test('Date methods: fields in local time, setters through mktime, getTime in ms', () => {
  const cls = new DateClass(() => utc(2014, 10, 18, 8, 23, 21), JST);
  const out = {value: null};
  const make = (args) => {
    assert.equal(cls.createNew(0, null, out, args, cls), 0);
    return out.value;
  };
  const call = (d, name, ...args) => {
    const r = new VariantSlot();
    assert.equal(d.funcCall(0, name, r, args, d), 0, name);
    return r.take();
  };
  const now = make([]);
  assert.deepEqual(
    ['getYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds'].map((m) =>
      Number(call(now, m).value),
    ),
    [2014, 10, 18, 2, 17, 23, 21],
  );
  assert.equal(call(now, 'getTime').value, BigInt(utc(2014, 10, 18, 8, 23, 21)) * 1000n);
  assert.equal(call(now, 'getTimezoneOffset').value, -540n);
  call(now, 'setMonth', V.int(13));
  assert.equal(call(now, 'getYear').value, 2015n);
  assert.equal(call(now, 'getMonth').value, 1n);
  call(now, 'setTime', V.int(1999));
  assert.equal(call(now, 'getTime').value, 1000n, 'setTime truncates to seconds');
  const fields = make([V.int(2001), V.int(0), V.int(2), V.int(3)]);
  assert.equal(call(fields, 'getTime').value, BigInt(utc(2001, 0, 1, 18)) * 1000n);
  const parsed = make([V.str('2004/03/03 11:22:33')]);
  assert.equal(call(parsed, 'getHours').value, 11n);
  assert.throws(() => make([V.int(1900)]), TjsError);
  for (const d of [now, fields, parsed]) d.release();
});
