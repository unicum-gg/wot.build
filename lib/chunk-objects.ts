// The static objects of a map in the older clients, read out of its chunks.
//
// Before `space.bin` compiled every placed model into one file, each 100 m
// cell of a space had a `XXXXYYYYo.chunk` of its own: a packed section listing
// what stands in it, one `<model>` per object with its `resource` (the model
// file) and its `transform` (a 3x3 rotation then the translation, in metres
// from the cell's own corner). The cell's place on the grid is in its name, as
// for the terrain cells. Read so the 1.0 rework can be compared against the
// `space.bin` of the clients after it, which names the same families.
import { decodePacked, type PackedNode } from "./packed.js";
import type { PlacedObject } from "./space-bin.js";

const CHUNK = /([0-9a-f]{4})([0-9a-f]{4})o\.chunk$/;
const CELL_METRES = 100;

const signed = (hex: string) => {
  const n = parseInt(hex, 16);
  return n >= 0x8000 ? n - 0x10000 : n;
};

/** `content/Buildings/bld_Foo/normal/lod0/Foo.model` -> `content/Buildings/bld_Foo`,
 * the family `space-bin.ts` reduces a placed model to. */
function family(path: string): string {
  return path.replace(/\/(?:normal|destroyed|crash)\/.*$/, "").replace(/\/[^/]*\.(?:model|primitives)$/, "");
}

const child = (node: PackedNode, name: string) => node.children.find((c) => c.name === name);

export function chunkObjects(chunks: { name: string; buf: Buffer }[]): PlacedObject[] {
  const out: PlacedObject[] = [];
  for (const { name, buf } of chunks) {
    const m = CHUNK.exec(name);
    if (!m) continue;
    const ox = signed(m[1]) * CELL_METRES;
    const oz = signed(m[2]) * CELL_METRES;
    let root: PackedNode;
    try {
      root = decodePacked(buf);
    } catch {
      continue;
    }
    for (const item of root.children) {
      if (item.name !== "model") continue;
      const resource = child(item, "resource")?.value;
      const transform = child(item, "transform")?.value;
      if (typeof resource !== "string" || !Array.isArray(transform) || transform.length < 12) continue;
      out.push({
        model: family(resource),
        x: ox + Number(transform[9]),
        y: Number(transform[10]),
        z: oz + Number(transform[11]),
      });
    }
  }
  return out;
}
