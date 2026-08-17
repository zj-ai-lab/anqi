#!/usr/bin/env node
/**
 * Build a modern PNG-backed ICNS without relying on iconutil.
 *
 * macOS 15.7's iconutil can reject otherwise valid .iconset folders with
 * "Invalid Iconset". The ICNS container is intentionally simple: each
 * standard macOS size is stored as a PNG-backed icon record.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const iconset = path.join(root, 'build', 'icon.iconset');
const output = path.join(root, 'build', 'icon.icns');

const records = [
  ['ic04', 'icon_16x16.png'],
  ['ic05', 'icon_32x32.png'],
  ['ic11', 'icon_16x16@2x.png'],
  ['ic12', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic13', 'icon_128x128@2x.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic14', 'icon_256x256@2x.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png'],
];

function pngDimensions(buffer, name) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${name} is not a PNG`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const chunks = [];
for (const [type, filename] of records) {
  const file = path.join(iconset, filename);
  if (!fs.existsSync(file)) throw new Error(`missing iconset member: ${file}`);
  const data = fs.readFileSync(file);
  const { width, height } = pngDimensions(data, filename);
  if (width !== height) throw new Error(`${filename} is not square: ${width}×${height}`);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  chunks.push(Buffer.concat([header, data]));
}

const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(output, Buffer.concat([header, body]));
console.log(`wrote ${output} (${body.length + 8} bytes)`);
