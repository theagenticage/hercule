// Writes moves/grain.png: a seamless tile of very fine noise, black at a few percent of alpha.
// A clear desk lays it over its sky, where a gradient this faint would otherwise fall into bands.
// Usage: node tools/make-grain.mjs
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
const N = 256;
let seed = 20261106;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(6.2831853 * rand());
const noise = new Float64Array(N * N).map(() => gauss());
// A small box blur that wraps at the edges, so the tile shows no seam when it repeats.
const fine = noise.map((_, i) => {
  const x = i % N, y = (i / N) | 0;
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += noise[((y + dy + N) % N) * N + ((x + dx + N) % N)];
  return sum / 9;
});
const deviation = Math.sqrt(fine.reduce((a, v) => a + v * v, 0) / fine.length);
const raw = Buffer.alloc((N * 2 + 1) * N);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const alpha = Math.max(0, Math.min(255, Math.round(3.5 + (fine[y * N + x] / deviation) * 2.4)));
    raw[y * (N * 2 + 1) + 1 + x * 2 + 1] = alpha;
  }
}
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, check]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(N, 0);
header.writeUInt32BE(N, 4);
header[8] = 8;
header[9] = 4;
writeFileSync("moves/grain.png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
