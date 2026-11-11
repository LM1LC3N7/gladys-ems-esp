// Runs the mutants of test/mutants.json one at a time, each in the same
// private copy of the repository (a `mktemp -d` folder of its own, removed at
// the end; node_modules copied, never linked), with the runner
// `node --test --test-timeout=60000 test/*.test.js` in its own process group,
// killed whole at the deadline. A mutant must make a test fail; a run that
// passes is a survivor, one that reaches the deadline is a hang (both
// reported). The unmodified suite runs first ("baseline FAILED", exit 1 when
// red). Usage: memcap node scripts/mutants.mjs [index...]
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DEADLINE = 240_000;
const { mutants } = JSON.parse(await readFile(join(ROOT, 'test/mutants.json'), 'utf8'));
const only = process.argv.slice(2).map(Number);
const dir = await mkdtemp(join(tmpdir(), 'ems-esp-mutants-'));
const run = () =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'node --test --test-timeout=60000 test/*.test.js'], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      process.kill(-child.pid, 'SIGKILL');
      resolve('hang');
    }, DEADLINE);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'survived' : 'killed');
    });
  });
try {
  await cp(ROOT, dir, { recursive: true, filter: (src) => basename(src) !== '.git' });
  // The unmodified suite first: a red baseline makes every mutant look killed.
  if ((await run()) !== 'survived') {
    console.log('baseline FAILED');
    process.exitCode = 1;
    throw new Error('baseline FAILED');
  }
  const results = [];
  for (const [i, m] of mutants.entries()) {
    if (only.length > 0 && !only.includes(i)) {
      continue;
    }
    const file = join(dir, m.file);
    const original = await readFile(file, 'utf8');
    const count = original.split(m.find).length - 1;
    if (count !== 1) {
      results.push(`${i} ${m.file}: find matches ${count} times`);
      continue;
    }
    await writeFile(file, original.replace(m.find, m.replace));
    const outcome = await run();
    await writeFile(file, original);
    results.push(
      `${i} ${outcome}${m.equivalent ? ' (equivalent)' : ''} ${m.file}: ${m.find.trim().split('\n')[0]}`,
    );
    console.log(results.at(-1));
  }
  const bad = results.filter((r) => !/ killed | survived \(equivalent\)/.test(r));
  console.log(`${results.length} mutants, ${bad.length} to look at`);
  process.exitCode = bad.length > 0 ? 1 : 0;
} finally {
  await rm(dir, { recursive: true, force: true });
}
