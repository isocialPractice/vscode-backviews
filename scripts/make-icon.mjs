/**
 * Rasterizes the corridor mark from media/icon.svg into media/icon.png with
 * no image dependencies: pixels are filled with point-in-polygon tests and
 * encoded as a minimal zlib-deflated PNG.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const CORNER = 24;

const BG = [0x1d, 0x20, 0x25, 255];
const SHAPES = [
  { points: [[24, 24], [104, 24], [84, 52], [44, 52]], color: [0xe9, 0xdd, 0x9c, 255] },
  { points: [[24, 104], [104, 104], [84, 76], [44, 76]], color: [0xb7, 0xa4, 0x5c, 255] },
  { points: [[24, 24], [44, 52], [44, 76], [24, 104]], color: [0xcd, 0xbb, 0x6b, 255] },
  { points: [[104, 24], [84, 52], [84, 76], [104, 104]], color: [0xa0, 0x8d, 0x4a, 255] },
  { points: [[44, 52], [84, 52], [84, 76], [44, 76]], color: [0x6f, 0x62, 0x33, 255] },
  { points: [[58, 56], [70, 56], [70, 76], [58, 76]], color: [0x15, 0x16, 0x1a, 255] },
  { points: [[56, 34], [72, 34], [72, 39], [56, 39]], color: [0xfd, 0xf6, 0xd0, 255] },
];

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insideRoundedSquare(x, y) {
  const r = CORNER;
  const cx = x < r ? r : x > SIZE - r ? SIZE - r : x;
  const cy = y < r ? r : y > SIZE - r ? SIZE - r : y;
  if (cx === x || cy === y) {
    return true;
  }
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Sample at the pixel center.
    const px = x + 0.5;
    const py = y + 0.5;
    let color = [0, 0, 0, 0];
    if (insideRoundedSquare(px, py)) {
      color = BG;
      for (const shape of SHAPES) {
        if (insidePolygon(shape.points, px, py)) {
          color = shape.color;
        }
      }
    }
    pixels.set(color, (y * SIZE + x) * 4);
  }
}

// PNG encoding: filter byte 0 per scanline, one IDAT chunk.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
