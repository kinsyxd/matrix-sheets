import { readFile, writeFile, readdir, mkdir, stat, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, deflateSync, constants } from 'node:zlib';
import { resolve, join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const LIMIT = 32 * 1024 * 1024;
const FRAME_SIZE = 28;
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

async function matrices() {
  if (!engine) {
    engine = await import('zxing-wasm/full');
    engine.prepareZXingModule({ overrides: { wasmBinary: readFileSync(new URL(import.meta.resolve('zxing-wasm/full/zxing_full.wasm'))) } });
  }
  return engine;
}

function argumentsOf(argv) {
  const values = { pages: '3', cell: 'auto', level: 'Q', width: '1920', height: '1080', compression: 'auto', version: 'auto', monitor: '0', seconds: '0', 'scan-width': '3072' };
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
  const pages = values.pages === 'auto' ? null : integer(values.pages, '--pages', 1, 1000);
  const cells = values.cell === 'auto' ? Array.from({ length: Math.floor(Math.min(width, height) / 29) - 1 }, (_, i) => i + 2) : [integer(values.cell, '--cell', 1, 256)];
  const versions = values.version === 'auto' ? Array.from({ length: 40 }, (_, i) => i + 1) : [integer(values.version, '--version', 1, 40)];
  const level = String(values.level).toUpperCase();
  if (!CAPACITY[level]) fail('--level must be L, M, Q or H');
  const choices = [];
  for (const cell of cells) for (const version of versions) {
    const tile = (25 + 4 * version) * cell;
    const columns = Math.floor(width / tile);
    const rows = Math.floor(height / tile);
    const payload = CAPACITY[level][version - 1] - FRAME_SIZE;
    if (!columns || !rows || payload < 1) continue;
    const parts = Math.max(pages ?? 1, Math.ceil(length / payload));
    if (parts > 65535 || parts > length) continue;
    const naturalPages = Math.ceil(parts / (columns * rows));
    if (pages && naturalPages > pages) continue;
    choices.push({ width, height, pages: pages ?? naturalPages, cell, version, level, tile, columns, rows, parts, partBytes: payload, bytesPerPage: columns * rows * payload });
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

async function pack(input, values, dry = false) {
  const { packet, info } = await packetFrom(input, values.compression);
  const layout = layoutFor(packet.length, values);
  json({ ...info, layout });
  if (dry) return;
  const output = resolve(values.out ?? 'out');
  try { if ((await readdir(output)).length) fail('Output directory is not empty'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true });
  const api = await matrices();
  const images = [];
  const tiles = [];
  const left = Math.floor((layout.width - layout.columns * layout.tile) / 2);
  const top = Math.floor((layout.height - layout.rows * layout.tile) / 2);
  for (let page = 0; page < layout.pages; page++) {
    const pixels = Buffer.alloc(layout.width * layout.height, 255);
    const first = Math.floor(page * layout.parts / layout.pages);
    const end = Math.floor((page + 1) * layout.parts / layout.pages);
    for (let index = first; index < end; index++) {
      const frame = frameFor(packet, index, layout.parts);
      const rendered = await api.writeBarcode(frame, { options: `version=${layout.version},ecLevel=${layout.level}`, scale: 1, addQuietZones: false });
      if (rendered.error || rendered.symbol.width !== 17 + 4 * layout.version) fail(rendered.error || 'Unexpected matrix dimensions');
      const symbol = rendered.symbol;
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

async function show(directory, values) {
  if (process.platform !== 'win32') fail('show is available on Windows; open PNG files in a fullscreen viewer');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const monitor = integer(values.monitor, '--monitor', 0, 15);
  const seconds = integer(values.seconds, '--seconds', 0, 3600);
  if (!Array.isArray(manifest.images) || !manifest.images.length || manifest.images.some(name => basename(name) !== name)) fail('Invalid image list');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$settings = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ScreenDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
[ScreenDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($settings.monitor -ge $screens.Length) { throw 'Monitor index is unavailable' }
$bounds = $screens[$settings.monitor].Bounds
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.AutoScaleMode = 'None'
$form.Bounds = $bounds
$form.BackColor = [System.Drawing.Color]::White
$form.KeyPreview = $true
$box = New-Object System.Windows.Forms.PictureBox
$box.Dock = 'Fill'
$box.SizeMode = 'CenterImage'
$form.Controls.Add($box)
$script:position = 0
$script:images = @($settings.files | ForEach-Object { [System.Drawing.Image]::FromFile($_) })
foreach ($image in $script:images) { if ($image.Width -gt $bounds.Width -or $image.Height -gt $bounds.Height) { throw 'A sheet exceeds the selected monitor; generate matching dimensions' } }
$box.Image = $script:images[0]
$form.Text = 'Matrix Sheets 1/' + $script:images.Length
$form.Add_KeyDown({
  if ($_.KeyCode -eq 'Escape') { $form.Close(); return }
  if ($_.KeyCode -in @('Right','Space','PageDown')) { $script:position = ($script:position + 1) % $script:images.Length }
  if ($_.KeyCode -in @('Left','PageUp')) { $script:position = ($script:position - 1 + $script:images.Length) % $script:images.Length }
  $box.Image = $script:images[$script:position]
  $form.Text = 'Matrix Sheets ' + ($script:position + 1) + '/' + $script:images.Length
})
$timer = New-Object System.Windows.Forms.Timer
if ($settings.seconds -gt 0) {
  $timer.Interval = $settings.seconds * 1000
  $timer.Add_Tick({ $script:position = ($script:position + 1) % $script:images.Length; $box.Image = $script:images[$script:position]; $form.Text = 'Matrix Sheets ' + ($script:position + 1) + '/' + $script:images.Length })
  $timer.Start()
}
$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose()
foreach ($image in $script:images) { $image.Dispose() }
$form.Dispose()
`;
  console.error('Right/Space: next; Left: previous; Esc: close');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(JSON.stringify({ files: manifest.images.map(name => join(resolve(directory), name)), monitor, seconds }));
  await new Promise((done, reject) => { child.once('error', reject); child.once('exit', status => status === 0 ? done() : reject(new Error(`Viewer exited with status ${status}`))); });
}

function help() {
  console.log(`Matrix Sheets
node matrix-sheets.mjs inspect input.txt [--pages 3 --cell auto --level Q]
node matrix-sheets.mjs pack input.txt --out out [--pages 3 --cell auto --level Q --show]
node matrix-sheets.mjs restore photos --out restored.txt [--manifest out/manifest.json --corners corners.json]
node matrix-sheets.mjs show out [--monitor 0 --seconds 0]
Options: --pages N|auto --cell N|auto --level L|M|Q|H --width N --height N
         --version N|auto --compression auto|none|gzip|brotli
         --scan-width N --transfer HEX --force --show --monitor N --seconds N --help`);
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
