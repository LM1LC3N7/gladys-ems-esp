// Generates cover.png (800x534) for gladys-ems-esp: plain Node, no
// dependency. A wall-hung boiler with a small ESP32 board on its two-wire EMS
// bus, a radiator and a hot water tank, the board on the house Wi-Fi, on a
// teal-to-warm gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [30 + 190 * t, 130 - 20 * t, 140 - 70 * t]);
  }
}
const white = [255, 255, 255];
const dark = [30, 36, 60];
const glass = [190, 215, 240];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

const red = [235, 80, 60];
const blue = [90, 170, 240];
const metal = [232, 234, 240];
const green = [90, 200, 120];

// Soft halo.
disc(400, 270, 260, white, 0.06);

// The radiator (left): fins, and its pipes to the boiler.
box(50, 250, 220, 420, 12, metal);
for (let i = 0; i < 7; i += 1) {
  box(62 + i * 22, 262, 76 + i * 22, 408, 6, [205, 210, 222]);
}
line(220, 300, 300, 300, 8, red);
line(220, 390, 300, 390, 8, blue);

// The wall-hung boiler (centre): body, display, flame.
box(300, 110, 500, 440, 22, metal);
box(330, 150, 470, 210, 10, dark);
disc(355, 180, 9, green);
line(380, 180, 450, 180, 6, glass);
disc(400, 330, 46, [255, 170, 60], 0.95);
disc(400, 345, 28, [255, 230, 120]);
line(360, 440, 360, 480, 8, red);
line(440, 440, 440, 480, 8, blue);

// The ESP32 board (green circuit, its chip, its antenna) on the two wires of
// the EMS bus, and its Wi-Fi waves.
box(515, 120, 600, 235, 8, [30, 120, 70]);
box(535, 150, 580, 195, 4, dark);
line(525, 128, 590, 128, 4, [230, 200, 90]);
disc(530, 220, 5, green);
line(500, 190, 515, 190, 3, white);
line(500, 205, 515, 205, 3, white);
for (const r of [16, 30, 44]) {
  for (let a = -0.8; a <= 0.8; a += 0.01) {
    disc(558 + r * Math.sin(a), 110 - r * Math.cos(a), 1.8, white, 0.9);
  }
}

// The hot water tank (right), its water warm at the top.
box(620, 260, 750, 470, 40, metal);
box(640, 290, 730, 380, 20, red, 0.75);
box(640, 380, 730, 450, 20, blue, 0.75);
line(500, 400, 620, 400, 8, red);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
