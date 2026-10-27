import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'matrix sheets standalone '));
const script = join(root, 'single.mjs');
await copyFile(join(project, 'matrix-sheets.mjs'), script);
const input = join(root, 'source with spaces.txt');
await writeFile(input, '\ufeffStandalone Привет 🙂\r\n');

test('version reports the executing module path', () => {
  const result = spawnSync(process.execPath, [script, 'version'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const version = JSON.parse(result.stdout);
  assert.equal(version.version, '2.3.0');
  assert.equal(resolve(version.entry), script);
});

test('one copied module packs monochrome and color under restricted code generation without dependencies', async () => {
  await assert.rejects(access(join(root, 'node_modules')));
  for (const preset of ['standard', 'dense-experimental', 'color-experimental']) {
    const out = join(root, preset);
    const answer = spawnSync(process.execPath, ['--jitless', '--disallow-code-generation-from-strings', script, 'pack', input, '--preset', preset, '--out', out], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(answer.error);
    assert.equal(answer.status, 0, answer.stderr);
    const result = JSON.parse(answer.stdout);
    assert.equal(result.layout.pages, 1);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json')));
    assert.equal(manifest.images.length, 1);
    const png = await readFile(join(out, manifest.images[0]));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  }
});

test('Git Bash wrapper works outside its directory with spaces in input/output paths', async t => {
  const bash = process.env.MSHEETS_BASH;
  if (!bash) return t.skip('Set MSHEETS_BASH to the Git Bash executable');
  const shellPath = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const output = join(root, 'wrapper output');
  const command = `source ${quote(shellPath(join(project, 'terminal.bash')))}\ncd ${quote(shellPath(root))}\nmsheets pack ${quote(shellPath(input))} --out ${quote(shellPath(output))}`;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', command], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).layout.pages, 1);
  await access(join(output, 'manifest.json'));
});
