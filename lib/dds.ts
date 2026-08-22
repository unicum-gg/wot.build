// DXT (DDS) decoding, the format the client stores its minimaps and UI atlases
// in. Kept apart from the generators because two of them need it: the minimaps
// are DXT1/DXT5 surfaces, and so is the battle atlas the map markers are cut
// from.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export type Decoded = { width: number; height: number; rgba: Buffer };
type Rgb = [number, number, number];

// DXT1 and DXT5 both encode colour as two RGB565 endpoints plus a 2-bit
// per-pixel selector; DXT5 adds an 8-bit alpha block ahead of it.
function unpack565(v: number): Rgb {
  const r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

// Decode a DXT1 or DXT5 DDS to RGBA. Minimaps are DXT1; DXT5 is handled too so
// the odd map with an alpha'd minimap still works.
export function decodeDDS(buf: Buffer): Decoded {
  if (buf.toString("ascii", 0, 4) !== "DDS ") throw new Error("not dds");
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const fourcc = buf.toString("ascii", 84, 88);
  const dxt5 = fourcc === "DXT5";
  if (fourcc !== "DXT1" && !dxt5) throw new Error(`unsupported ${fourcc}`);
  const rgba = Buffer.alloc(width * height * 4);
  let o = 128;
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      let alphaAt: ((i: number) => number) | null = null;
      if (dxt5) {
        const a0 = buf[o], a1 = buf[o + 1];
        const at = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i < 7; i++) at[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        else {
          for (let i = 1; i < 5; i++) at[i + 1] = ((5 - i) * a0 + i * a1) / 5;
          at[6] = 0;
          at[7] = 255;
        }
        const lo = buf.readUIntLE(o + 2, 3);
        const hi = buf.readUIntLE(o + 5, 3);
        alphaAt = (i) => at[(i < 8 ? lo >> (3 * i) : hi >> (3 * (i - 8))) & 7];
        o += 8;
      }
      const c0 = buf.readUInt16LE(o), c1 = buf.readUInt16LE(o + 2);
      const bits = buf.readUInt32LE(o + 4);
      o += 8;
      const p0 = unpack565(c0), p1 = unpack565(c1);
      const pal: Rgb[] = [p0, p1, [0, 0, 0], [0, 0, 0]];
      if (dxt5 || c0 > c1) {
        pal[2] = [(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3];
        pal[3] = [(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3];
      } else {
        pal[2] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
      }
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x2 = bx + px, y2 = by + py;
          if (x2 >= width || y2 >= height) continue;
          const idx = (bits >> (2 * (py * 4 + px))) & 3;
          const c = pal[idx];
          const d = (y2 * width + x2) * 4;
          rgba[d] = c[0]; rgba[d + 1] = c[1]; rgba[d + 2] = c[2];
          rgba[d + 3] = alphaAt ? alphaAt(py * 4 + px) : 255;
        }
      }
    }
  }
  return { width, height, rgba };
}

// ---- Per-map extraction ------------------------------------------------------
// Decode one inner `.dds` from an already-unpacked map `.pkg` and write it as a
// WebP. `required` maps get the standard top-down minimap; the Onslaught variant
// (`mmap_comp7.dds`, a reduced play area shipped only by some maps) is optional.
export async function ddsInnerToWebp(
  dir: string,
  pkgPath: string,
  inner: string,
  outFile: string,
  required: boolean,
  /** Square edge to resample to; the client's own size when omitted. */
  size?: number,
): Promise<void> {
  const ddsDir = path.join(dir, "dds");
  fs.rmSync(ddsDir, { recursive: true, force: true });
  execFileSync("7z", ["x", pkgPath, `-i!${inner}`, `-o${ddsDir}`, "-y"], { stdio: "ignore" });
  const ddsPath = path.join(ddsDir, inner);
  if (!fs.existsSync(ddsPath)) {
    if (required) throw new Error(`no ${inner} in pkg`);
    return;
  }
  const { width, height, rgba } = decodeDDS(fs.readFileSync(ddsPath));
  let img = sharp(rgba, { raw: { width, height, channels: 4 } });
  if (size && size !== width) {
    img = img.resize(size, size, { kernel: "lanczos3" });
  }
  await img.webp({ quality: 88 }).toFile(outFile);
}

