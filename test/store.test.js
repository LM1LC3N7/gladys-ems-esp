// -----------------------------------------------------------------------------
// /data: read back bounded, written whole and private, never waited on when
// it is no regular file (a FIFO), unreadable never taken for empty.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);
const STOP = {
  key: '0123456789abcdef',
  circuit: 'dhw1',
  phase: 'sent',
  tries: 1,
  resends: 2,
  starts: 1,
};

test('read back bounded: pause capped, future dates invalid, unknown keys dropped', () => {
  const m = normalizeMemory(
    {
      pausedUntil: NOW + 30 * 3600_000,
      lastReadAt: NOW + 1000,
      refused: true,
      fp: 'zz',
      extra: 'x',
      stops: [{ key: 'abc', circuit: 'dhw1', phase: 'sent' }],
    },
    NOW,
  );
  assert.equal(m.pausedUntil, NOW + 6 * 3600_000);
  assert.equal(m.lastReadAt, 0);
  assert.equal(m.refused, true, 'a refusal without a readable print is kept');
  assert.equal(m.fp, '');
  assert.deepEqual(m.stops, {}, 'a stop without a valid key is dropped');
  assert.deepEqual(normalizeMemory({ stops: [STOP] }, NOW).stops, { dhw1: STOP });
  for (const bad of [
    { ...STOP, circuit: 'hc9' },
    { ...STOP, circuit: '__proto__' },
    { ...STOP, circuit: 'dhw5' },
    { ...STOP, circuit: 'heating1' },
    { ...STOP, phase: 'done' },
    { ...STOP, phase: 'done' },
  ]) {
    assert.deepEqual(normalizeMemory({ stops: [bad] }, NOW).stops, {}, JSON.stringify(bad));
  }
  const stop = normalizeMemory(
    { stops: [{ ...STOP, phase: 'unsent', tries: 'x', resends: -1, starts: 5 }] },
    NOW,
  ).stops.dhw1;
  assert.deepEqual(
    [stop.tries, stop.resends, stop.starts],
    [0, 3, 0],
    'unreadable resends are spent; refusals and starts unreadable are none',
  );
  assert.equal(normalizeMemory(JSON.parse('{"__proto__":{"refused":true}}'), NOW).refused, false);
  assert.deepEqual(Object.keys(serializeMemory(m)).sort(), [
    'fp',
    'lastReadAt',
    'pausedUntil',
    'refused',
    'salt',
    'stops',
  ]);
  // A flag of this run only is never written.
  const live = normalizeMemory({ stops: [STOP] }, NOW);
  live.stops.dhw1.live = true;
  assert.deepEqual(serializeMemory(live).stops, [STOP]);
});

test('the file: 0600, written whole; unreadable is not empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ems-esp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null, 'no file: empty');
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  await assert.rejects(store.load());
  await writeFile(path, 'x'.repeat(9000));
  await assert.rejects(store.load());
});

test('a FIFO in place of the file or of its temporary: refused at once, never waited on', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ems-esp-'));
  const path = join(dir, 'state.json');
  // Whatever happens, both FIFOs get a reader and a writer at the end (before
  // the folder goes): a blocked open (a regression) is woken, the test fails
  // and never hangs.
  t.after(async () => {
    for (const fifo of [path, `${path}.tmp`]) {
      const handle = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK).catch(() => null);
      // Held open a moment: a writer blocked in open() gets its reader.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await handle?.close();
    }
    await rm(dir, { recursive: true, force: true });
  });
  execFileSync('mkfifo', [path]);
  execFileSync('mkfifo', [`${path}.tmp`]);
  const store = fileStore(path);
  const within = (promise) =>
    Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(resolve, 1000, 'stuck')).then((v) => v),
    ]);
  assert.equal(await within(store.load()), 'rejected');
  // Refused for what it is (no regular file), not for its content.
  await assert.rejects(store.load(), /^Error: unreadable$/);
  assert.equal(await within(store.save({ a: 1 })), 'rejected');
});
