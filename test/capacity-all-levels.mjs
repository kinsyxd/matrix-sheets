import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import * as zxing from 'zxing-wasm/full';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'matrix sheets capacity oracle '));
const source = await readFile(join(project, 'matrix-sheets.mjs'), 'utf8');
const entry = /^main\(\)\.catch\(error => \{ console\.error\(error\.message\); process\.exit\(1\); \}\);\s*$/m;
assert.match(source, entry);
const scratch = join(root, 'instrumented-copy.mjs');
await writeFile(scratch, source.replace(entry, 'export { byteCapacity, matrixFrom };'));
const internal = await import(pathToFileURL(scratch).href);
const require = createRequire(import.meta.url);
zxing.prepareZXingModule({ overrides: { wasmBinary: await readFile(resolve(dirname(require.resolve('zxing-wasm/full')), '../../full/zxing_full.wasm')) } });

test('all 160 version/ECC byte capacities match independent limits and generated QR payloads decode exactly', async () => {
  const evidence = [];
  for (let version = 1; version <= 40; version++) for (const level of ['L', 'M', 'Q', 'H']) {
    const capacity = internal.byteCapacity(version, level);
    const bytes = Buffer.alloc(capacity, 128);
    const options = { format: 'QRCode', options: `version=${version},ecLevel=${level},eci=0`, scale: 1 };
    const maximum = await zxing.writeBarcode(bytes, options);
    assert.equal(maximum.error, '', `Independent encoder rejected v${version}${level} capacity ${capacity}`);
    assert.equal(maximum.symbol.width, 17 + version * 4);
    const excessive = await zxing.writeBarcode(Buffer.alloc(capacity + 1, 128), options);
    assert.match(excessive.error, /too long/i, `Independent encoder accepted v${version}${level} capacity+1`);
    assert.throws(() => internal.matrixFrom(Buffer.alloc(capacity + 1, 128), version, level), /capacity/);
    const matrix = internal.matrixFrom(bytes, version, level);
    const side = matrix.width + 8;
    const pixels = Buffer.alloc(side * side, 255);
    for (let row = 0; row < matrix.height; row++) Buffer.from(matrix.data).copy(pixels, (row + 4) * side + 4, row * matrix.width, (row + 1) * matrix.width);
    const png = await sharp(pixels, { raw: { width: side, height: side, channels: 1 } }).resize({ width: side * 3, kernel: 'nearest' }).png().toBuffer();
    const decoded = await zxing.readBarcodes(new Uint8Array(png), { tryHarder: true, maxNumberOfSymbols: 1 });
    assert.equal(decoded.length, 1, `Production QR v${version}${level} was not decoded`);
    assert.deepEqual(Buffer.from(decoded[0].bytes), bytes, `Production QR v${version}${level} payload changed`);
    evidence.push({ version, level, capacity, maximumAccepted: true, overflowRejected: true, exactIndependentDecode: true });
  }
  await writeFile(join(root, 'capacity-evidence.json'), JSON.stringify(evidence, null, 2));
  assert.equal(evidence.length, 160);
  console.log(`Capacity evidence: ${join(root, 'capacity-evidence.json')}`);
});
