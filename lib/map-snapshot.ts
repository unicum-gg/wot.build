// What one version of a map's package holds, kept small enough to cache for
// every version a change is measured between.
//
// The packages themselves are 50 to 300 MB each and a full visual history reads
// a few hundred of them, so they are read once and reduced to what the
// comparison needs: each entry's checksum (which files an update touched), the
// terrain heights of every cell (where the ground moved), and the placed
// objects (what was built or pulled down). Comparing two snapshots then costs
// no download, so a threshold can be retuned without reading the Archive again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { chunkObjects } from "./chunk-objects.js";
import { placedObjects, type PlacedObject } from "./space-bin.js";

/** One terrain cell: 100 m square, named by its grid position. */
export type TerrainCell = {
  /** Vertices per side, borders included (69 on every map measured: 64
   * visible intervals plus two vertices before and three after). */
  size: number;
  /** Heights in metres, row by row from the cell's south edge. */
  heights: Float32Array;
  /** Checksum of the ground's texture blend, which moves when the ground is
   * repainted without being reshaped. */
  blend: string;
};

export type MapSnapshot = {
  /** Package entry -> CRC. */
  entries: Record<string, string>;
  /** `x,z` grid position -> cell. */
  cells: Map<string, TerrainCell>;
  /** From `space.bin`, or from the per-cell `.chunk` files of the clients
   * before it. Null when neither can be read. */
  objects: PlacedObject[] | null;
};

/** `fffafffbo.cdata_processed` -> `-6,-5`. The clients before 1.0 name the
 * same cell `.cdata`, with the same `terrain2/heights` inside. */
const CELL = /^spaces\/[^/]+\/([0-9a-f]{4})([0-9a-f]{4})o\.cdata(?:_processed)?$/;
const signed = (hex: string) => {
  const n = parseInt(hex, 16);
  return n >= 0x8000 ? n - 0x10000 : n;
};

function listing(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = execFileSync("7z", ["l", "-slt", file], { encoding: "utf8", maxBuffer: 512 << 20 });
  for (const entry of text.split(/\r?\n\r?\n/)) {
    const name = /^Path = (.+)$/m.exec(entry)?.[1];
    const crc = /^CRC = (\w+)$/m.exec(entry)?.[1];
    if (name && crc) out[name] = crc;
  }
  return out;
}

/** `terrain2/heights`: an `hmp` header (width, height, range) then a PNG
 * whose RGBA pixels are little-endian int32 millimetres. */
async function decodeHeights(buf: Buffer): Promise<{ size: number; heights: Float32Array } | null> {
  if (buf.toString("latin1", 0, 3) !== "hmp") return null;
  const size = buf.readUInt32LE(4);
  const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (png < 0) return null;
  const { data, info } = await sharp(buf.subarray(png)).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.channels !== 4) return null;
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = data.readInt32LE(i * 4) / 1000;
  return { size, heights };
}

/** Read a map package into a snapshot. `id` is the arena (and space) id. */
export async function snapshotPackage(pkg: string, id: string): Promise<MapSnapshot> {
  const entries = listing(pkg);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-"));
  try {
    execFileSync(
      "7z",
      [
        "x",
        pkg,
        `-i!spaces/${id}/*o.cdata_processed`,
        `-i!spaces/${id}/*o.cdata`,
        `-i!spaces/${id}/*o.chunk`,
        `-i!spaces/${id}/space.bin`,
        `-o${work}`,
        "-y",
      ],
      { stdio: "ignore" },
    );
    const cells = new Map<string, TerrainCell>();
    for (const name of Object.keys(entries)) {
      const m = CELL.exec(name);
      if (!m) continue;
      const file = path.join(work, name);
      if (!fs.existsSync(file)) continue;
      const parts = listing(file);
      const out = path.join(work, "cell");
      fs.rmSync(out, { recursive: true, force: true });
      execFileSync("7z", ["x", file, "terrain2/heights", `-o${out}`, "-y"], { stdio: "ignore" });
      const heightsFile = path.join(out, "terrain2", "heights");
      if (!fs.existsSync(heightsFile)) continue;
      const decoded = await decodeHeights(fs.readFileSync(heightsFile));
      if (!decoded) continue;
      cells.set(`${signed(m[1])},${signed(m[2])}`, { ...decoded, blend: parts["terrain2/blend_textures"] ?? "" });
    }
    const spaceBin = path.join(work, "spaces", id, "space.bin");
    const chunks = Object.keys(entries)
      .filter((name) => name.startsWith(`spaces/${id}/`) && name.endsWith("o.chunk"))
      .map((name) => path.join(work, name))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ name: path.basename(file), buf: fs.readFileSync(file) }));
    const objects = fs.existsSync(spaceBin)
      ? placedObjects(fs.readFileSync(spaceBin))
      : chunks.length > 0
        ? chunkObjects(chunks)
        : null;
    return { entries, cells, objects };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

type Stored = {
  entries: Record<string, string>;
  cells: Record<string, { size: number; heights: string; blend: string }>;
  objects: [string, number, number, number][] | null;
};

export function writeSnapshot(file: string, snapshot: MapSnapshot): void {
  const stored: Stored = {
    entries: snapshot.entries,
    cells: Object.fromEntries(
      [...snapshot.cells].map(([key, c]) => [
        key,
        { size: c.size, blend: c.blend, heights: Buffer.from(c.heights.buffer, c.heights.byteOffset, c.heights.byteLength).toString("base64") },
      ]),
    ),
    objects: snapshot.objects?.map((o) => [o.model, o.x, o.y, o.z]) ?? null,
  };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(stored)));
}

export function readSnapshot(file: string): MapSnapshot {
  const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")) as Stored;
  return {
    entries: stored.entries,
    cells: new Map(
      Object.entries(stored.cells).map(([key, c]) => {
        // Copied out: a decoded Buffer may sit at an offset Float32Array refuses.
        const heights = new Float32Array(new Uint8Array(Buffer.from(c.heights, "base64")).buffer);
        return [key, { size: c.size, blend: c.blend, heights }];
      }),
    ),
    objects: stored.objects?.map(([model, x, y, z]) => ({ model, x, y, z })) ?? null,
  };
}
