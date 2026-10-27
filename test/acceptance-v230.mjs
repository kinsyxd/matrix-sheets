import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(project, 'matrix-sheets.mjs');
const root = await mkdtemp(join(tmpdir(), 'matrix sheets acceptance '));
const legacy = process.env.MSHEETS_LEGACY_ROOT;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deterministicBytes = length => {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  for (let block = 0; offset < length; block++) {
    const next = createHash('sha256').update(`matrix-sheets-fixture-${block}`).digest();
    next.copy(bytes, offset);
    offset += next.length;
  }
  return bytes;
};
async function fixture(name, bytes) {
  const file = join(root, name);
  await writeFile(file, bytes);
  return file;
}
function invoke(args, options = {}) {
  const answer = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024, cwd: root, ...options,
  });
  assert.ifError(answer.error);
  return answer;
}
function run(args) {
  const answer = invoke(args);
  assert.equal(answer.status, 0, `${args.join(' ')}\n${answer.stderr}\n${answer.stdout}`);
  return JSON.parse(answer.stdout);
}
async function pack(name, bytes, flags = []) {
  const input = await fixture(`${name}.bin`, bytes);
  const directory = join(root, name);
  const answer = run(['pack', input, '--out', directory, ...flags]);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')));
  return { input, directory, answer, manifest, bytes };
}
async function restore(name, packed, paths = [packed.directory], withManifest = true, flags = []) {
  const output = join(root, `${name}-restored.bin`);
  const answer = run(['restore', ...paths, '--out', output,
    ...(withManifest ? ['--manifest', join(packed.directory, 'manifest.json')] : []), ...flags]);
  assert.equal(answer.verified, true);
  const restored = await readFile(output);
  assert.deepEqual(restored, packed.bytes);
  assert.equal(answer.sha256, digest(packed.bytes));
  return answer;
}
async function refuse(name, paths, flags = []) {
  const output = join(root, `${name}-must-not-exist.bin`);
  const answer = invoke(['restore', ...paths, '--out', output, ...flags]);
  assert.equal(answer.status, 1, answer.stdout);
  await assert.rejects(access(output));
  return answer.stderr;
}

async function syntheticPerspective(source, destination) {
  const loaded = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const corners = [[140, 110], [2440, 165], [2350, 1490], [195, 1430]];
  const [a, b, c, d] = corners;
  const dx1 = b[0] - c[0], dx2 = d[0] - c[0], dx3 = a[0] - b[0] + c[0] - d[0];
  const dy1 = b[1] - c[1], dy2 = d[1] - c[1], dy3 = a[1] - b[1] + c[1] - d[1];
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const m = [b[0] - a[0] + g * b[0], d[0] - a[0] + h * d[0], a[0],
    b[1] - a[1] + g * b[1], d[1] - a[1] + h * d[1], a[1], g, h, 1];
  const inv = [m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]];
  const width = 2560, height = 1600;
  const pixels = Buffer.alloc(width * height * 3, 55);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const divisor = inv[6] * x + inv[7] * y + inv[8];
    const u = (inv[0] * x + inv[1] * y + inv[2]) / divisor;
    const v = (inv[3] * x + inv[4] * y + inv[5]) / divisor;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const sx = Math.round(u * (loaded.info.width - 1));
    const sy = Math.round(v * (loaded.info.height - 1));
    const offset = (sy * loaded.info.width + sx) * loaded.info.channels;
    for (let channel = 0; channel < 3; channel++) pixels[(y * width + x) * 3 + channel] = loaded.data[offset + channel];
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: '4:2:0' }).toFile(destination);
  return corners;
}

console.log(`Acceptance artifacts: ${root}`);

test('automatic planning minimizes pages before cell size; metadata cannot choose a profile', async () => {
  const small = await fixture('small.txt', 'hello');
  const tiny = run(['inspect', small]);
  assert.equal(tiny.layout.pages, 1);
  assert.ok(tiny.layout.cell >= 2);
  assert.equal(tiny.layout.level, 'Q');
  for (const size of [5000, 10000, 36000]) {
    const file = await fixture(`planning-${size}.bin`, deterministicBytes(size));
    const automatic = run(['inspect', file, '--width', '512', '--height', '512', '--compression', 'none']);
    const feasible = run(['inspect', file, '--width', '512', '--height', '512', '--compression', 'none', '--cell', '2']);
    assert.equal(automatic.layout.pages, feasible.layout.pages);
    assert.ok(automatic.layout.cell >= 2);
  }
  const ascii = await fixture('metadata-a.txt', 'a'.repeat(60000));
  const unicode = await fixture('metadata-b.txt', 'Ж'.repeat(30000));
  const a = run(['inspect', ascii, '--compression', 'none']);
  const b = run(['inspect', unicode, '--compression', 'none']);
  assert.equal(a.packageBytes, b.packageBytes);
  assert.notEqual(a.characters, b.characters);
  assert.deepEqual(a.layout, b.layout);
});

test('fixed options, exact nonempty pages, and frontloaded occupancy', async () => {
  const file = await fixture('fixed.bin', deterministicBytes(5000));
  const fixed = run(['inspect', file, '--cell', '3', '--version', '10', '--level', 'H', '--width', '800', '--height', '640']);
  assert.equal(fixed.layout.cell, 3);
  assert.equal(fixed.layout.version, 10);
  assert.equal(fixed.layout.level, 'H');
  assert.equal(fixed.layout.width, 800);
  assert.equal(fixed.layout.height, 640);
  const explicitOne = run(['inspect', file, '--cell', '1']);
  assert.equal(explicitOne.layout.cell, 1);
  const packed = await pack('frontload', deterministicBytes(850), ['--compression', 'none', '--cell', '2', '--version', '10', '--level', 'Q', '--width', '390', '--height', '292']);
  const { layout, tiles } = packed.manifest;
  const capacity = layout.columns * layout.rows;
  assert.equal(capacity, 6);
  assert.equal(layout.parts, 8);
  assert.deepEqual(Array.from({ length: layout.pages }, (_, page) => tiles.filter(tile => tile.page === page + 1).length), [6, 2]);
  assert.equal(tiles.length, layout.parts);
  assert.deepEqual(tiles.map(tile => tile.index), Array.from({ length: layout.parts }, (_, i) => i));
  const exact = await pack('exact-pages', Buffer.from('small payload'), ['--pages', '3']);
  assert.equal(exact.manifest.images.length, 3);
  for (let page = 1; page <= 3; page++) assert.ok(exact.manifest.tiles.some(tile => tile.page === page));
  for (const item of [packed, exact]) {
    assert.equal(item.manifest.layout.pagePlan.length, item.manifest.layout.pages);
    assert.equal(item.manifest.layout.pagePlan.reduce((n, page) => n + page.parts, 0), item.manifest.layout.parts);
    assert.equal(item.manifest.layout.pagePlan.reduce((n, page) => n + page.physicalTiles, 0), item.manifest.tiles.length);
  }
  await restore('frontload', packed);
  const impossible = invoke(['inspect', file, '--pages', '1', '--width', '128', '--height', '128', '--cell', '3']);
  assert.equal(impossible.status, 1);
});

test('Unicode, BOM, UTF-16, binary and empty files roundtrip byte for byte', async () => {
  const text = 'Hello Привет 🙂\r\n';
  const le = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  const cases = [
    ['utf8', Buffer.from(text)], ['bom', Buffer.from(`\ufeff${text}`)],
    ['utf16le', le], ['utf16be', Buffer.from(le).swap16()],
    ['binary', Buffer.from([255, 0, 128, 253, 17, 10, 13])], ['empty', Buffer.alloc(0)],
  ];
  for (const [name, bytes] of cases) {
    const packed = await pack(name, bytes);
    await restore(name, packed);
  }
});

test('two and three RGB bitplanes recover with and without manifests', async () => {
  for (const layers of [2, 3]) {
    const packed = await pack(`color-${layers}`, deterministicBytes(2600), ['--preset', 'color-experimental', '--layers', String(layers), '--compression', 'none', '--cell', '4', '--version', '12']);
    assert.equal(packed.answer.layout.layers, layers);
    assert.equal(packed.answer.layout.codec, 'rgb-bitplanes-v1');
    const png = await sharp(join(packed.directory, packed.manifest.images[0])).metadata();
    assert.equal(png.channels, 3);
    await restore(`color-${layers}-manifest`, packed);
    await restore(`color-${layers}-blind`, packed, [packed.directory], false);
    const jpeg = join(root, `color-${layers}-quality90.jpg`);
    await sharp(join(packed.directory, packed.manifest.images[0])).jpeg({ quality: 90, chromaSubsampling: '4:2:0' }).toFile(jpeg);
    await restore(`color-${layers}-jpeg`, packed, [jpeg]);
    const scaled = join(root, `color-${layers}-scaled-cast.jpg`);
    await sharp(join(packed.directory, packed.manifest.images[0])).resize({ width: 2880 }).linear([0.88, 0.94, 0.82], [12, 5, 18]).jpeg({ quality: 92, chromaSubsampling: '4:2:0' }).toFile(scaled);
    await restore(`color-${layers}-scaled-cast`, packed, [scaled], false);
    if (layers === 3) {
      const perspective = join(root, 'color-3-synthetic-perspective.jpg');
      const points = await syntheticPerspective(join(packed.directory, packed.manifest.images[0]), perspective);
      const cornerMap = await fixture('synthetic-corners.json', JSON.stringify({ [basename(perspective)]: points }));
      await restore('color-3-synthetic-perspective', packed, [perspective], true, ['--corners', cornerMap]);
    }
    const explicit2 = run(['inspect', packed.input, '--preset', 'color-experimental', '--layers', String(layers), '--cell', '2']);
    assert.equal(explicit2.layout.cell, 2);
  }
  const input = await fixture('preset-check.bin', deterministicBytes(5000));
  const automatic = run(['inspect', input, '--preset', 'color-experimental']);
  assert.ok(automatic.layout.cell >= 3);
  assert.ok([2, 3].includes(automatic.layout.layers));
  const dense = run(['inspect', input, '--preset', 'dense-experimental']);
  assert.equal(dense.layout.cell, 2);
  assert.equal(dense.layout.level, 'L');
  const comparison = run(['inspect', input, '--compare']);
  assert.ok(JSON.stringify(comparison).includes('color-experimental'));
});

test('missing and damaged transfers never create an output', async () => {
  const packed = await pack('missing', deterministicBytes(5000), ['--compression', 'none', '--pages', '2', '--cell', '3']);
  await refuse('missing-sheet', [join(packed.directory, packed.manifest.images[0])]);
  const blank = join(root, 'blank.png');
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: 'white' } }).png().toFile(blank);
  await refuse('blank', [blank]);
  if (legacy) {
    const corrupted = join(legacy, 'work', 'node-corrupt.png');
    const error = await refuse('crc', [corrupted]);
    assert.match(error, /CRC32|No matching parts found/);
  }
});

test('independently encoded invalid frames, package hashes, sizes and source hashes are rejected', async () => {
  const require = createRequire(import.meta.url);
  const api = await import('zxing-wasm/full');
  api.prepareZXingModule({ overrides: { wasmBinary: await readFile(resolve(dirname(require.resolve('zxing-wasm/full')), '../../full/zxing_full.wasm')) } });
  const crc32 = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  for (const fault of ['crc', 'transfer', 'size', 'sha256']) {
    const payload = Buffer.from('independent integrity fixture');
    const packet = Buffer.alloc(43 + payload.length);
    packet.write('MSP1');
    packet.writeUInt32BE(payload.length + (fault === 'size' ? 1 : 0), 5);
    Buffer.from(digest(payload), 'hex').copy(packet, 9);
    if (fault === 'sha256') packet[9] ^= 1;
    payload.copy(packet, 43);
    const frame = Buffer.alloc(28 + packet.length);
    frame.write('MSF1');
    Buffer.from(digest(packet), 'hex').copy(frame, 4, 0, 16);
    if (fault === 'transfer') frame[4] ^= 1;
    frame.writeUInt16BE(1, 22);
    packet.copy(frame, 28);
    frame.writeUInt32BE(crc32(Buffer.concat([frame.subarray(0, 24), packet])), 24);
    if (fault === 'crc') frame[24] ^= 1;
    const encoded = await api.writeBarcode(frame, { format: 'QRCode', options: 'ecLevel=Q', scale: 6 });
    assert.equal(encoded.error, '');
    assert.ok(encoded.image);
    const image = await fixture(`invalid-${fault}.png`, Buffer.from(await encoded.image.arrayBuffer()));
    const error = await refuse(`independent-${fault}`, [image]);
    assert.match(error, fault === 'crc' ? /CRC32|No matching parts found/ : fault === 'transfer' ? /integrity/ : /size or SHA-256/);
  }
});

test('old monochrome PNG and manifest compatibility', { skip: !legacy && 'Set MSHEETS_LEGACY_ROOT to the v2.2 evidence root' }, async () => {
  const directory = join(legacy, 'outputs', 'photo-test');
  const bytes = await readFile(join(directory, 'source.txt'));
  await restore('legacy-png', { directory, bytes });
});

test('original Samsung S25 photographs recover the legacy source', { skip: !legacy && 'Set MSHEETS_LEGACY_ROOT and MSHEETS_S25_DIRECTORY' }, async t => {
  const directory = process.env.MSHEETS_S25_DIRECTORY;
  if (!directory) return t.skip('MSHEETS_S25_DIRECTORY was not provided');
  const photos = ['20261009_014701.jpg', '20261009_014708.jpg', '20261009_014713.jpg'].map(name => join(directory, name));
  for (const photo of photos) await access(photo);
  const golden = join(legacy, 'outputs', 'photo-test');
  const bytes = await readFile(join(golden, 'source.txt'));
  await restore('s25-originals', { directory: golden, bytes }, photos, false);
});
