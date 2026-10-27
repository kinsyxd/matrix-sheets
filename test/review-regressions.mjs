import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import * as zxing from 'zxing-wasm/full';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(project, 'matrix-sheets.mjs');
const root = await mkdtemp(join(tmpdir(), 'matrix sheets review regressions '));
const require = createRequire(import.meta.url);
zxing.prepareZXingModule({ overrides: { wasmBinary: await readFile(resolve(dirname(require.resolve('zxing-wasm/full')), '../../full/zxing_full.wasm')) } });
const deterministic = length => {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 32) createHash('sha256').update(String(i)).digest().copy(bytes, i);
  return bytes;
};
const invoke = args => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
};
const run = args => {
  const result = invoke(args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};
async function restore(name, image, bytes, flags = []) {
  const output = join(root, `${name}-restored`);
  assert.equal(run(['restore', image, '--out', output, ...flags]).verified, true);
  assert.deepEqual(await readFile(output), bytes);
}
console.log(`Review regression artifacts: ${root}`);

test('exact QR byte capacities agree with an independent encoder and decode at the limit', async () => {
  for (const [version, capacity] of [[6, 74], [10, 151], [37, 1423]]) {
    const options = { format: 'QRCode', options: `version=${version},ecLevel=Q,eci=0`, scale: 1 };
    const maximum = await zxing.writeBarcode(Buffer.alloc(capacity, 128), options);
    assert.equal(maximum.error, '');
    assert.equal(maximum.symbol.width, 17 + version * 4);
    const overflow = await zxing.writeBarcode(Buffer.alloc(capacity + 1, 128), options);
    assert.match(overflow.error, /too long/i);
    const input = join(root, 'p');
    const bytes = deterministic(capacity - 28 - 44);
    await writeFile(input, bytes);
    const side = (25 + version * 4) * 3;
    const flags = ['--version', String(version), '--cell', '3', '--width', String(side), '--height', String(side + 32), '--level', 'Q', '--compression', 'none', '--pages', '1'];
    const out = join(root, `capacity-${version}`);
    const packed = run(['pack', input, '--out', out, ...flags]);
    assert.equal(packed.layout.parts, 1);
    assert.equal(packed.layout.partBytes, capacity - 28);
    const image = join(out, 'sheet-001.png');
    const decoded = await zxing.readBarcodes(new Uint8Array(await readFile(image)), { tryHarder: true });
    const frame = decoded.map(item => Buffer.from(item.bytes)).find(item => item.toString('ascii', 0, 4) === 'MSF1');
    assert.ok(frame, `Independent decoder could not read version ${version}`);
    assert.equal(frame.length, capacity);
    await restore(`capacity-${version}`, image, bytes);
    await writeFile(input, Buffer.concat([bytes, Buffer.from([128])]));
    const rejected = invoke(['inspect', input, ...flags]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /does not fit/);
  }
});

test('previously undercounted default and small fixed layouts fit one sheet', async () => {
  const file = join(root, 'd');
  const bytes = deterministic(20881);
  await writeFile(file, bytes);
  const out = join(root, 'default-capacity');
  const packed = run(['pack', file, '--compression', 'none', '--out', out]);
  assert.equal(packed.packageBytes, 20925);
  assert.equal(packed.layout.pages, 1);
  await restore('default-capacity', out, bytes);
  const small = join(root, 'p');
  await writeFile(small, deterministic(76));
  const planned = run(['inspect', small, '--compression', 'none', '--version', '10', '--cell', '2', '--width', '130', '--height', '162']);
  assert.equal(planned.packageBytes, 120);
  assert.equal(planned.layout.pages, 1);
  assert.equal(planned.layout.parts, 1);
});

test('color automatic ties prefer two layers when pages and cell sizes match', async () => {
  const file = join(root, 'tie-fixture.bin');
  await writeFile(file, deterministic(14000));
  const flags = ['inspect', file, '--compression', 'none', '--preset', 'color-experimental'];
  const two = run([...flags, '--layers', '2']);
  const three = run([...flags, '--layers', '3']);
  assert.equal(two.packageBytes, 14058);
  assert.equal(two.layout.pages, three.layout.pages);
  assert.equal(two.layout.cell, three.layout.cell);
  assert.equal(two.layout.pages, 1);
  assert.equal(two.layout.cell, 3);
  assert.equal(run(flags).layout.layers, 2);
});

test('comparison still reports feasible alternatives when the selected preset cannot fit', async () => {
  const file = join(root, 'compare.bin');
  await writeFile(file, deterministic(100));
  const flags = ['inspect', file, '--compression', 'none', '--pages', '1', '--width', '150', '--height', '170', '--version', '10'];
  assert.equal(invoke(flags).status, 1);
  const comparison = run([...flags, '--compare']);
  assert.equal(comparison.layout, null);
  assert.match(comparison.selectedError, /does not fit/);
  assert.equal(comparison.compare.standard.feasible, false);
  assert.match(comparison.compare.standard.reason, /does not fit/);
  assert.equal(comparison.compare['dense-experimental'].pages, 1);
  const invalid = invoke([...flags, '--compare', '--level', 'INVALID']);
  assert.equal(invalid.status, 1);
});

test('global mixed-palette calibration survives scaling, scan resizing, and tile cropping', async () => {
  const bytes = Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 71) % 256));
  const file = join(root, 'calibration.bin');
  await writeFile(file, bytes);
  const mix = [[0.45, 0.40, 0.15], [0.15, 0.45, 0.40], [0.40, 0.15, 0.45]];
  for (const [name, width, height] of [['fullhd', 1920, 1080], ['compact', 1280, 800]]) {
    const out = join(root, `calibration-${name}`);
    const flags = ['--preset', 'color-experimental', '--layers', '3', '--version', '12', '--cell', '4', '--compression', 'none', '--width', String(width), '--height', String(height)];
    run(['pack', file, '--out', out, ...flags]);
    const native = join(root, `${name}-mixed-native.png`);
    const scaled = join(root, `${name}-mixed-scaled.png`);
    await sharp(join(out, 'sheet-001.png')).recomb(mix).png().toFile(native);
    await sharp(native).resize({ width: width * 1.5, kernel: 'nearest' }).png().toFile(scaled);
    await restore(`${name}-mixed-native`, native, bytes);
    await restore(`${name}-mixed-scaled`, scaled, bytes);
    await restore(`${name}-mixed-scan-resized`, scaled, bytes, ['--scan-width', String(width)]);
  }
});
