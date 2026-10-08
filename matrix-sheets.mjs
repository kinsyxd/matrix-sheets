import { readFile, writeFile, readdir, mkdir, stat, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, deflateSync, constants } from 'node:zlib';
import { resolve, join, basename } from 'node:path';

const LIMIT = 32 * 1024 * 1024;
const FRAME_SIZE = 28;
const LABEL_HEIGHT = 32;
const METHODS = ['none', 'gzip', 'brotli'];
const CAPACITY = {
  L: [13,28,49,74,102,130,150,188,226,267,317,363,421,454,516,582,640,714,788,854,925,999,1087,1167,1269,1363,1461,1524,1624,1728,1836,1948,2064,2184,2299,2427,2559,2695,2805,2949],
  M: [10,22,38,58,80,102,118,148,176,209,247,283,327,358,408,446,500,556,620,662,707,775,853,907,993,1055,1121,1186,1260,1366,1448,1534,1624,1718,1805,1907,1985,2095,2209,2327],
  Q: [7,16,28,42,56,70,82,104,126,147,173,199,237,254,288,318,360,390,438,478,505,561,607,657,711,747,801,864,904,978,1026,1108,1164,1224,1279,1347,1419,1495,1575,1659],
  H: [3,10,20,30,40,54,60,80,94,115,133,151,173,190,216,246,276,306,334,378,399,435,457,507,531,589,621,654,694,738,786,838,894,954,979,1047,1089,1135,1215,1269]
};
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
const hash = bytes => createHash('sha256').update(bytes).digest();
const crc = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const json = value => console.log(JSON.stringify(value, null, 2));
const fail = message => { throw new Error(message); };
let engine;
let imaging;

const PARITY_SIZE = {
  L: [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
};
const GROUPS = {
  L: [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
};
const POWERS = new Uint8Array(512);
const LOGS = new Uint8Array(256);
let field = 1;
for (let i = 0; i < 255; i++) {
  POWERS[i] = field;
  LOGS[field] = i;
  field <<= 1;
  if (field & 256) field ^= 0x11d;
}
for (let i = 255; i < 512; i++) POWERS[i] = POWERS[i - 255];
const product = (a, b) => a && b ? POWERS[LOGS[a] + LOGS[b]] : 0;

function parityFor(bytes, degree) {
  let polynomial = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(polynomial.length + 1);
    for (let j = 0; j < polynomial.length; j++) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= product(polynomial[j], POWERS[i]);
    }
    polynomial = next;
  }
  const message = new Uint8Array(bytes.length + degree);
  message.set(bytes);
  for (let i = 0; i < bytes.length; i++) {
    const factor = message[i];
    for (let j = 1; factor && j < polynomial.length; j++) message[i + j] ^= product(factor, polynomial[j]);
  }
  return message.slice(bytes.length);
}

function scoreMatrix(pixels, size) {
  let score = 0, dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const value = pixels[y * size + x];
    dark += value;
    if (x && y && value === pixels[y * size + x - 1] && value === pixels[(y - 1) * size + x] && value === pixels[(y - 1) * size + x - 1]) score += 3;
  }
  for (let axis = 0; axis < 2; axis++) for (let line = 0; line < size; line++) {
    let previous = -1, run = 0, window = 0;
    for (let i = 0; i < size; i++) {
      const value = pixels[axis ? i * size + line : line * size + i];
      run = value === previous ? run + 1 : 1;
      previous = value;
      if (run === 5) score += 3;
      if (run > 5) score++;
      window = ((window << 1) | value) & 2047;
      if (i >= 10 && (window === 0b10111010000 || window === 0b00001011101)) score += 40;
    }
  }
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

function matrixFrom(bytes, version, level) {
  const size = 17 + version * 4;
  let pixels = new Uint8Array(size * size);
  const fixed = new Uint8Array(pixels.length);
  const set = (x, y, value) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    pixels[y * size + x] = Number(Boolean(value));
    fixed[y * size + x] = 1;
  };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3,3],[size - 4,3],[3,size - 4]]) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      set(cx + x, cy + y, distance !== 2 && distance !== 4);
    }
  }
  if (version > 1) {
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let i = count - 2; i >= 0; i--) positions.push(size - 7 - i * step);
    for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
      if (row === 0 && (column === 0 || column === count - 1) || row === count - 1 && column === 0) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(positions[column] + x, positions[row] + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
  const format = mask => {
    const value = ({ L: 1, M: 0, Q: 3, H: 2 }[level] << 3) | mask;
    let remainder = value;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder & 512) ? 0x537 : 0);
    const bits = ((value << 10) | remainder) ^ 0x5412;
    const bit = i => (bits >>> i) & 1;
    for (let i = 0; i < 6; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, 1);
  };
  format(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder & 2048) ? 0x1f25 : 0);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, (bits >>> i) & 1); set(b, a, (bits >>> i) & 1);
    }
  }
  const rawBytes = Math.floor(fixed.reduce((total, value) => total + (value ? 0 : 1), 0) / 8);
  const degree = PARITY_SIZE[level][version - 1], groups = GROUPS[level][version - 1];
  const data = Buffer.alloc(rawBytes - degree * groups);
  const countBits = version < 10 ? 8 : 16;
  if (4 + countBits + bytes.length * 8 > data.length * 8) fail('Part exceeds matrix capacity');
  let cursor = 0;
  const append = (value, count) => {
    for (let i = count - 1; i >= 0; i--) { if ((value >>> i) & 1) data[cursor >>> 3] |= 128 >>> (cursor & 7); cursor++; }
  };
  append(4, 4); append(bytes.length, countBits);
  for (const byte of bytes) append(byte, 8);
  cursor += Math.min(4, data.length * 8 - cursor);
  cursor = Math.ceil(cursor / 8) * 8;
  for (let pad = 0; cursor < data.length * 8; pad++) { data[cursor >>> 3] = pad % 2 ? 0x11 : 0xec; cursor += 8; }
  const shortLength = Math.floor(rawBytes / groups) - degree;
  const shortGroups = groups - rawBytes % groups;
  const blocks = [], checks = [];
  let offset = 0;
  for (let i = 0; i < groups; i++) {
    const length = shortLength + (i >= shortGroups ? 1 : 0);
    const block = data.subarray(offset, offset + length);
    offset += length;
    blocks.push(block); checks.push(parityFor(block, degree));
  }
  const stream = [];
  for (let i = 0; i <= shortLength; i++) for (const block of blocks) if (i < block.length) stream.push(block[i]);
  for (let i = 0; i < degree; i++) for (const check of checks) stream.push(check[i]);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column++) {
        const position = y * size + right - column;
        if (fixed[position]) continue;
        pixels[position] = index < stream.length * 8 ? (stream[index >>> 3] >>> (7 - (index & 7))) & 1 : 0;
        index++;
      }
    }
  }
  const masks = [
    (x,y) => (x+y)%2 === 0, (x,y) => y%2 === 0, (x,y) => x%3 === 0, (x,y) => (x+y)%3 === 0,
    (x,y) => (Math.floor(x/3)+Math.floor(y/2))%2 === 0, (x,y) => x*y%2+x*y%3 === 0,
    (x,y) => (x*y%2+x*y%3)%2 === 0, (x,y) => ((x+y)%2+x*y%3)%2 === 0
  ];
  const base = pixels.slice();
  let best, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    pixels = base.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y * size + x] && masks[mask](x,y)) pixels[y * size + x] ^= 1;
    format(mask);
    const score = scoreMatrix(pixels, size);
    if (score < bestScore) { bestScore = score; best = pixels; }
  }
  return { data: Uint8Array.from(best, value => value ? 0 : 255), width: size, height: size };
}

async function matrices() {
  if (!engine) {
    try {
      engine = await import('zxing-wasm/reader');
      engine.prepareZXingModule({ overrides: { wasmBinary: readFileSync(new URL(import.meta.resolve('zxing-wasm/reader/zxing_reader.wasm'))) } });
    } catch (error) { fail(`Photo restoration dependencies are unavailable: ${error.message}. See README for installation.`); }
  }
  return engine;
}

async function images() {
  if (!imaging) {
    try { imaging = (await import('sharp')).default; }
    catch (error) { fail(`Image loading dependency is unavailable: ${error.message}. See README for installation.`); }
  }
  return imaging;
}

function argumentsOf(argv) {
  const values = { pages: '3', cell: 'auto', level: 'Q', width: '1920', height: '1080', compression: 'auto', version: 'auto', 'scan-width': '3072' };
  const files = [];
  const switches = new Set(['show', 'force', 'help']);
  const allowed = new Set([...Object.keys(values), 'out', 'manifest', 'corners', 'transfer']);
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--') { files.push(...argv.slice(i + 1)); break; }
    if (!item.startsWith('--')) { files.push(item); continue; }
    const [name, inline] = item.slice(2).split(/=(.*)/s);
    if (switches.has(name) && inline === undefined) values[name] = true;
    else if (allowed.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) fail(`Missing value for --${name}`);
      values[name] = value;
    } else fail(`Unknown argument: ${item}`);
  }
  return { values, files };
}

function integer(value, name, min, max) {
  if (!/^\d+$/.test(String(value))) fail(`${name} must be an integer`);
  const number = Number(value);
  if (number < min || number > max) fail(`${name} must be between ${min} and ${max}`);
  return number;
}

async function packetFrom(path, method) {
  if ((await stat(path)).size > LIMIT) fail('Input exceeds 32 MiB');
  const source = await readFile(path);
  if (!['auto', ...METHODS].includes(method)) fail('Invalid compression method');
  const candidates = new Map();
  if (method === 'auto' || method === 'none') candidates.set(0, source);
  if (method === 'auto' || method === 'gzip') candidates.set(1, gzipSync(source, { level: 9 }));
  if (method === 'auto' || method === 'brotli') candidates.set(2, brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  const [selected, payload] = [...candidates].sort((a, b) => a[1].length - b[1].length)[0];
  const name = Buffer.from(basename(path), 'utf8');
  if (name.length > 4096) fail('File name is too long');
  const header = Buffer.alloc(43);
  header.write('MSP1');
  header[4] = selected;
  header.writeUInt32BE(source.length, 5);
  hash(source).copy(header, 9);
  header.writeUInt16BE(name.length, 41);
  const packet = Buffer.concat([header, name, payload]);
  const info = packetInfo(packet);
  info.candidates = Object.fromEntries([...candidates].map(([key, value]) => [METHODS[key], value.length]));
  return { packet, info };
}

function packetInfo(packet) {
  if (packet.length < 43 || packet.toString('ascii', 0, 4) !== 'MSP1') fail('Invalid package');
  const size = packet.readUInt32BE(5);
  const nameLength = packet.readUInt16BE(41);
  const offset = 43 + nameLength;
  if (packet[4] >= METHODS.length || size > LIMIT || nameLength > 4096 || offset > packet.length) fail('Invalid package metadata');
  return { name: packet.toString('utf8', 43, offset), originalBytes: size, compressedBytes: packet.length - offset, packageBytes: packet.length, compression: METHODS[packet[4]], sha256: packet.subarray(9, 41).toString('hex'), payloadOffset: offset };
}

function layoutFor(length, values) {
  const width = integer(values.width, '--width', 128, 8192);
  const height = integer(values.height, '--height', 128, 8192);
  const contentHeight = height - LABEL_HEIGHT;
  const pages = values.pages === 'auto' ? null : integer(values.pages, '--pages', 1, 1000);
  const cells = values.cell === 'auto' ? Array.from({ length: Math.floor(Math.min(width, contentHeight) / 29) - 1 }, (_, i) => i + 2) : [integer(values.cell, '--cell', 1, 256)];
  const versions = values.version === 'auto' ? Array.from({ length: 40 }, (_, i) => i + 1) : [integer(values.version, '--version', 1, 40)];
  const level = String(values.level).toUpperCase();
  if (!CAPACITY[level]) fail('--level must be L, M, Q or H');
  const choices = [];
  for (const cell of cells) for (const version of versions) {
    const tile = (25 + 4 * version) * cell;
    const columns = Math.floor(width / tile);
    const rows = Math.floor(contentHeight / tile);
    const payload = CAPACITY[level][version - 1] - FRAME_SIZE;
    if (!columns || !rows || payload < 1) continue;
    const parts = Math.max(pages ?? 1, Math.ceil(length / payload));
    if (parts > 65535 || parts > length) continue;
    const naturalPages = Math.ceil(parts / (columns * rows));
    if (pages && naturalPages > pages) continue;
    choices.push({ width, height, contentHeight, labelHeight: LABEL_HEIGHT, pages: pages ?? naturalPages, cell, version, level, tile, columns, rows, parts, partBytes: payload, bytesPerPage: columns * rows * payload });
  }
  choices.sort((a, b) => a.pages - b.pages || b.cell - a.cell || a.parts - b.parts || a.version - b.version);
  if (!choices.length) fail('The package does not fit. Increase --pages, or use --pages auto --cell 3.');
  return choices[0];
}

function frameFor(packet, index, total) {
  const chunk = packet.subarray(Math.floor(index * packet.length / total), Math.floor((index + 1) * packet.length / total));
  const frame = Buffer.alloc(FRAME_SIZE + chunk.length);
  frame.write('MSF1');
  hash(packet).copy(frame, 4, 0, 16);
  frame.writeUInt16BE(index, 20);
  frame.writeUInt16BE(total, 22);
  chunk.copy(frame, FRAME_SIZE);
  frame.writeUInt32BE(crc(Buffer.concat([frame.subarray(0, 24), chunk])), 24);
  return frame;
}

function parseFrame(bytes) {
  const frame = Buffer.from(bytes);
  if (frame.length < FRAME_SIZE || frame.toString('ascii', 0, 4) !== 'MSF1') return null;
  const index = frame.readUInt16BE(20);
  const total = frame.readUInt16BE(22);
  const chunk = frame.subarray(FRAME_SIZE);
  if (!total || index >= total || !chunk.length) fail('Invalid part metadata');
  if (frame.readUInt32BE(24) !== crc(Buffer.concat([frame.subarray(0, 24), chunk]))) fail('A part failed CRC32 verification');
  return { transfer: frame.subarray(4, 20).toString('hex'), index, total, chunk };
}

function pngChunk(type, bytes) {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc(Buffer.concat([label, bytes])));
  return Buffer.concat([length, label, bytes, checksum]);
}

function pngFrom(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function numberPage(pixels, width, height, page, total) {
  const glyphs = {
    '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
    '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
    '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
    '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
    '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
    '/': ['001','001','010','100','100'], ' ': ['000','000','000','000','000']
  };
  const label = `${page} / ${total}`;
  const scale = Math.min(3, Math.floor(width / (label.length * 4 - 1)));
  const left = Math.floor((width - (label.length * 4 - 1) * scale) / 2);
  const top = height - LABEL_HEIGHT + Math.floor((LABEL_HEIGHT - 5 * scale) / 2);
  for (let i = 0; i < label.length; i++) for (let row = 0; row < 5; row++) for (let column = 0; column < 3; column++) {
    if (glyphs[label[i]][row][column] !== '1') continue;
    for (let dy = 0; dy < scale; dy++) {
      const start = (top + row * scale + dy) * width + left + (i * 4 + column) * scale;
      pixels.fill(0, start, start + scale);
    }
  }
}

async function pack(input, values, dry = false) {
  const { packet, info } = await packetFrom(input, values.compression);
  const layout = layoutFor(packet.length, values);
  json({ ...info, layout });
  if (dry) return;
  const output = resolve(values.out ?? 'out');
  try { if ((await readdir(output)).length) fail('Output directory is not empty'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true });
  const images = [];
  const tiles = [];
  const left = Math.floor((layout.width - layout.columns * layout.tile) / 2);
  const top = Math.floor((layout.contentHeight - layout.rows * layout.tile) / 2);
  for (let page = 0; page < layout.pages; page++) {
    const pixels = Buffer.alloc(layout.width * layout.height, 255);
    const first = Math.floor(page * layout.parts / layout.pages);
    const end = Math.floor((page + 1) * layout.parts / layout.pages);
    for (let index = first; index < end; index++) {
      const frame = frameFor(packet, index, layout.parts);
      const symbol = matrixFrom(frame, layout.version, layout.level);
      const slot = index - first;
      const x = left + (slot % layout.columns) * layout.tile;
      const y = top + Math.floor(slot / layout.columns) * layout.tile;
      for (let row = 0; row < symbol.height; row++) for (let column = 0; column < symbol.width; column++) {
        if (symbol.data[row * symbol.width + column] >= 128) continue;
        for (let dy = 0; dy < layout.cell; dy++) {
          const start = (y + (row + 4) * layout.cell + dy) * layout.width + x + (column + 4) * layout.cell;
          pixels.fill(0, start, start + layout.cell);
        }
      }
      tiles.push({ page: page + 1, index, x, y, size: layout.tile });
    }
    const name = `sheet-${String(page + 1).padStart(3, '0')}.png`;
    numberPage(pixels, layout.width, layout.height, page + 1, layout.pages);
    await writeFile(join(output, name), pngFrom(pixels, layout.width, layout.height));
    images.push(name);
    console.error(`Saved ${name} (${end - first} parts)`);
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ format: 'MSP1', ...info, transfer: hash(packet).subarray(0, 16).toString('hex'), layout, images, tiles }, null, 2) + '\n');
  if (values.show) await show(output, values);
}

function solve(rows) {
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    if (Math.abs(divisor) < 1e-10) fail('Invalid corner geometry');
    for (let k = col; k <= 8; k++) rows[col][k] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== col) {
      const factor = rows[row][col];
      for (let k = col; k <= 8; k++) rows[row][k] -= factor * rows[col][k];
    }
  }
  return rows.map(row => row[8]);
}

function rectify(image, points, width, height) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v)))) fail('Corners must contain four [x,y] pairs');
  const target = [[0,0],[width - 1,0],[width - 1,height - 1],[0,height - 1]];
  const equations = [];
  for (let i = 0; i < 4; i++) {
    const [x,y] = target[i];
    const [u,v] = points[i];
    if (u < 0 || v < 0 || u >= image.width || v >= image.height) fail('Corners fall outside the oriented photo');
    equations.push([x,y,1,0,0,0,-u*x,-u*y,u], [0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  const h = solve(equations);
  const data = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const denominator = h[6]*x + h[7]*y + 1;
    const u = (h[0]*x + h[1]*y + h[2]) / denominator;
    const v = (h[3]*x + h[4]*y + h[5]) / denominator;
    const sx = Math.floor(u), sy = Math.floor(v);
    if (sx < 0 || sy < 0 || sx + 1 >= image.width || sy + 1 >= image.height) continue;
    const dx = u - sx, dy = v - sy, offset = sy * image.width + sx;
    data[y * width + x] = Math.round(image.data[offset]*(1-dx)*(1-dy) + image.data[offset+1]*dx*(1-dy) + image.data[offset+image.width]*(1-dx)*dy + image.data[offset+image.width+1]*dx*dy);
  }
  return { data, width, height };
}

function crop(image, x, y, width, height) {
  const data = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) image.data.copy(data, row * width, (y + row) * image.width + x, (y + row) * image.width + x + width);
  return { data, width, height };
}

function rgba(image) {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0; i < image.data.length; i++) {
    data[i*4] = data[i*4+1] = data[i*4+2] = image.data[i];
    data[i*4+3] = 255;
  }
  return { data, width: image.width, height: image.height };
}

async function imageFiles(paths) {
  const files = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) files.push(...(await readdir(path)).filter(name => /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(name)).sort().map(name => join(path, name)));
    else files.push(path);
  }
  if (!files.length) fail('No images found');
  return files;
}

async function restore(paths, values) {
  if (!values.out) fail('restore requires --out');
  const output = resolve(values.out);
  if (!values.force) {
    try { await access(output); fail('Output file already exists; use --force to replace it'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const files = await imageFiles(paths);
  const manifest = values.manifest ? JSON.parse(await readFile(values.manifest, 'utf8')) : null;
  if (manifest && (!manifest.layout || !Array.isArray(manifest.tiles))) fail('Invalid manifest');
  const cornerMap = values.corners ? JSON.parse(await readFile(values.corners, 'utf8')) : null;
  if (cornerMap && !manifest) fail('--corners requires --manifest');
  const scanWidth = integer(values['scan-width'], '--scan-width', 0, 8192);
  if (scanWidth > 0 && scanWidth < 256) fail('--scan-width must be 0 or between 256 and 8192');
  const api = await matrices();
  const sharp = await images();
  const groups = new Map();
  const accept = results => {
    for (const result of results) {
      const frame = parseFrame(result.bytes);
      if (!frame || (values.transfer && frame.transfer !== values.transfer)) continue;
      const group = groups.get(frame.transfer) ?? { total: frame.total, parts: new Map() };
      if (group.total !== frame.total) fail('Conflicting part counts');
      const previous = group.parts.get(frame.index);
      if (previous && !previous.equals(frame.chunk)) fail('Conflicting duplicate parts');
      group.parts.set(frame.index, frame.chunk);
      groups.set(frame.transfer, group);
    }
  };
  const scan = async image => accept(await api.readBarcodes(rgba(image), { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 0 }));
  for (const file of files) {
    const points = cornerMap?.[basename(file)];
    const pipeline = sharp(file, { limitInputPixels: 80_000_000 }).rotate().removeAlpha().greyscale();
    if (scanWidth && !points) pipeline.resize({ width: scanWidth, height: scanWidth, fit: 'inside', withoutEnlargement: true });
    const loaded = await pipeline.raw().toBuffer({ resolveWithObject: true });
    let image = { data: loaded.data, width: loaded.info.width, height: loaded.info.height };
    if (points) image = rectify(image, points, integer(manifest.layout.width, 'manifest width', 128, 8192), integer(manifest.layout.height, 'manifest height', 128, 8192));
    await scan(image);
    if (!points && scanWidth && Math.max(image.width, image.height) >= scanWidth) {
      const side = Math.round(scanWidth * 2 / 3);
      const smaller = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 1 } }).resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
      await scan({ data: smaller.data, width: smaller.info.width, height: smaller.info.height });
    }
    if (manifest && (points || image.width === manifest.layout.width && image.height === manifest.layout.height)) {
      const boxes = new Map(manifest.tiles.map(tile => [`${tile.x},${tile.y},${tile.size}`, tile]));
      for (const box of boxes.values()) {
        const x = integer(box.x, 'tile x', 0, image.width - 1), y = integer(box.y, 'tile y', 0, image.height - 1);
        const size = integer(box.size, 'tile size', 1, Math.min(image.width - x, image.height - y));
        await scan(crop(image, x, y, size, size));
      }
    } else {
      for (const divisions of [2, 3]) {
        const width = Math.min(image.width, Math.ceil(image.width / divisions * 1.2));
        const height = Math.min(image.height, Math.ceil(image.height / divisions * 1.2));
        for (let row = 0; row < divisions; row++) for (let col = 0; col < divisions; col++) {
          const x = Math.round(col * (image.width - width) / (divisions - 1));
          const y = Math.round(row * (image.height - height) / (divisions - 1));
          await scan(crop(image, x, y, width, height));
        }
      }
    }
    console.error(`${basename(file)}: ${[...groups].map(([id,g]) => `${id} ${g.parts.size}/${g.total}`).join('; ') || 'no parts found'}`);
  }
  if (groups.size !== 1) fail(groups.size ? 'Multiple transfers found; select one with --transfer' : 'No matching parts found');
  const [transfer, group] = [...groups][0];
  const missing = Array.from({ length: group.total }, (_, i) => i).filter(i => !group.parts.has(i));
  if (missing.length) fail(`Missing ${missing.length} parts: ${missing.slice(0, 30).map(i => i + 1).join(', ')}${missing.length > 30 ? ', ...' : ''}`);
  const packet = Buffer.concat(Array.from({ length: group.total }, (_, i) => group.parts.get(i)));
  if (packet.length > LIMIT + 8192 || hash(packet).subarray(0,16).toString('hex') !== transfer) fail('Package integrity check failed');
  const info = packetInfo(packet);
  const payload = packet.subarray(info.payloadOffset);
  const options = { maxOutputLength: Math.max(1, info.originalBytes + 1) };
  const source = info.compression === 'gzip' ? gunzipSync(payload, options) : info.compression === 'brotli' ? brotliDecompressSync(payload, options) : payload;
  if (source.length !== info.originalBytes || hash(source).toString('hex') !== info.sha256) fail('Restored file failed size or SHA-256 verification');
  await writeFile(output, source, { flag: values.force ? 'w' : 'wx' });
  json({ output, ...info, verified: true });
}

async function show(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.images) || !manifest.images.length || manifest.images.some(name => basename(name) !== name)) fail('Invalid image list');
  const files = manifest.images.map(name => join(resolve(directory), name));
  for (const file of files) if (!(await stat(file)).isFile()) fail('A sheet is unavailable');
  json({ images: files, viewing: 'Open the PNG files in an approved image viewer at 100% scale.' });
}

function help() {
  console.log(`Matrix Sheets
node matrix-sheets.mjs inspect input.txt [--pages 3 --cell auto --level Q]
node matrix-sheets.mjs pack input.txt --out out [--pages 3 --cell auto --level Q --show]
node matrix-sheets.mjs restore photos --out restored.txt [--manifest out/manifest.json --corners corners.json]
node matrix-sheets.mjs show out
Options: --pages N|auto --cell N|auto --level L|M|Q|H --width N --height N
         --version N|auto --compression auto|none|gzip|brotli
         --scan-width N --transfer HEX --force --show --help`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { values, files } = argumentsOf(argv);
  if (!command || command === 'help' || command === '--help' || values.help) return help();
  if (['pack', 'inspect', 'show'].includes(command) && files.length !== 1) fail(`${command} requires one input path`);
  if (command === 'pack' || command === 'inspect') return pack(files[0], values, command === 'inspect');
  if (command === 'restore') { if (!files.length) fail('restore requires images or a directory'); return restore(files, values); }
  if (command === 'show') return show(files[0], values);
  fail(`Unknown command: ${command}`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
