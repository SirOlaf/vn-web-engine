import test from 'node:test';
import assert from 'node:assert/strict';
import {NifBuffer, NifKind} from '../dist/compiler/nif/buffer.js';
import {NifPool} from '../dist/compiler/nif/pool.js';
import {NifTags} from '../dist/compiler/nif/tags.js';
import {NifSyntaxError, readNif, writeNif, writeNifTree} from '../dist/compiler/nif/text.js';

const tags = () => new NifTags('test', ['stmts', 'call', 'add', 'neg']);
const compact = (text) => text.replace(/\s+/g, ' ').trim();

test('NIF buffer builds nodes, wraps left operands and navigates by subtree size', () => {
  const pool = new NifPool(),
    t = tags(),
    buf = new NifBuffer(pool, t, 2);
  const stmts = buf.open(t.id.stmts);
  const left = buf.length;
  buf.addIdent('a');
  const add = buf.openBefore(left, t.id.add);
  buf.addInt(1);
  buf.close(add);
  const call = buf.open(t.id.call);
  buf.addSymbol('f.0');
  buf.addString('x');
  buf.addDot();
  buf.close(call);
  buf.close(stmts);
  assert.equal(buf.openNodes, 0);
  assert.deepEqual(buf.children(stmts), [1, 4]);
  assert.equal(buf.tagName(1), 'add');
  assert.deepEqual(
    buf.children(1).map((p) => buf.kind(p)),
    [NifKind.Ident, NifKind.Int],
  );
  assert.equal(buf.text(buf.child(4, 0)), 'f.0');
  assert.equal(buf.end(stmts), buf.length);
  assert.equal(
    compact(writeNifTree(buf, stmts, {positions: false})),
    '(stmts (add a 1) (call f.0 "x" .))',
  );
});

test('NIF integers keep 64-bit values inline or pooled; floats stay distinct from integers', () => {
  const pool = new NifPool(),
    buf = new NifBuffer(pool, tags());
  const values = [
    0n,
    -1n,
    (1n << 26n) - 1n,
    -(1n << 26n),
    1n << 26n,
    -(1n << 63n),
    (1n << 63n) - 1n,
  ];
  for (const v of values) buf.addInt(v);
  buf.addUInt((1n << 64n) - 1n);
  buf.addFloat(1);
  buf.addFloat(-0);
  assert.deepEqual(
    values.map((_, i) => buf.integer(i)),
    values,
  );
  assert.equal(buf.integer(values.length), (1n << 64n) - 1n);
  assert.equal(buf.kind(values.length + 1), NifKind.Float);
  const text = writeNif(buf, [...Array(buf.length).keys()], {positions: false});
  assert.match(text, /^\(\.nif27\)\n0\n-1\n/);
  assert.match(text, /18446744073709551615u\n1\.0\n-0\.0\n$/);
  const back = readNif(text, pool, tags());
  for (let i = 0; i < buf.length; i++)
    assert.ok(back.buffer.sameTree(back.roots[i], buf, i), `atom ${i}`);
  assert.ok(Object.is(back.buffer.float(back.roots.at(-1)), -0));
});

test('NIF text escapes control characters and keeps Unicode, lone surrogates and positions', () => {
  const pool = new NifPool(),
    t = tags(),
    buf = new NifBuffer(pool, t);
  const file = pool.file('dir/some file,1.tjs');
  const stmts = buf.open(t.id.stmts, pool.position(file, 3, 4));
  buf.addString(
    'quote " backslash \\ (paren) #@:~ tab\t nl\n 日本語 \ud800 end',
    pool.position(file, 3, 1),
  );
  buf.addIdent('名前 with space', pool.position(file, 5, 200));
  buf.addSymbolDef('x.12', pool.position(file, 2, 0));
  buf.addChar(0x28);
  const neg = buf.open(t.id.neg, pool.position(pool.file('other.tjs'), 1, 0));
  buf.addInt(5, pool.position(pool.file('other.tjs'), 1, 1));
  buf.close(neg);
  buf.close(stmts);

  const text = writeNif(buf, [stmts]);
  assert.ok(
    !/[()]/.test(text.slice(text.indexOf('"'), text.lastIndexOf('"')).replace(/\\28|\\29/g, '')),
  );
  assert.match(text, /\(stmts@4,3,dir\/some\\20file\\2C1\.tjs/);
  assert.match(text, /:x\.12~4,~1/);
  const back = readNif(text, pool, tags());
  const root = back.roots[0];
  assert.ok(back.buffer.sameTree(root, buf, stmts));
  const a = [0, 0, 0],
    b = [0, 0, 0];
  for (let i = 0; i < buf.length; i++)
    assert.deepEqual(
      pool.unpack(back.buffer.info(root + i), a),
      pool.unpack(buf.info(stmts + i), b),
      `token ${i}`,
    );
});

test('NIF reader accepts the spec forms: directives, comments, base-62 diffs and shorthand negatives', () => {
  const pool = new NifPool();
  const {buffer, roots, directives} = readNif(
    '(.nif27)\n(.vendor "x")\n(stmts@1,1,m.nim#root# (call@5,3 f~3 "a"@z) ... 1.5E-3 -12)',
    pool,
    new NifTags('spec', []),
  );
  assert.deepEqual(directives, ['.nif27', '.vendor "x"']);
  const root = roots[0];
  assert.equal(buffer.childCount(root), 6);
  const call = buffer.child(root, 0);
  const pos = (p) => pool.unpack(buffer.info(p), [0, 0, 0]);
  assert.deepEqual(pos(call), [pool.file('m.nim'), 4, 6]);
  assert.deepEqual(pos(call + 1), [pool.file('m.nim'), 4, 3]);
  assert.deepEqual(pos(call + 2), [pool.file('m.nim'), 4, 6 + 61]);
  assert.equal(buffer.float(buffer.child(root, 4)), 0.0015);
  assert.equal(buffer.integer(buffer.child(root, 5)), -12n);
  assert.throws(() => readNif('(a (b)', pool, new NifTags('spec', [])), NifSyntaxError);
});
