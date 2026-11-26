// The static objects a map places, read out of its compiled `space.bin`.
//
// A map's houses, fences, rocks and wrecks are not in its terrain cells: they
// are compiled into one file, `spaces/<id>/space.bin`, a table of sections
// tagged with four letters (`BWTB` first, describing the table itself). Three
// of them name every placed model:
//
// - `BWST`, the string table: entries of (key, offset, length) over one blob.
// - `BSMO`, the models: one 36-byte record per model, the string key of its
//   geometry at byte 24 (`content/Buildings/.../normal/lod0/X.primitives`).
// - `BSMI`, the instances: a 4x4 transform per placed object (translation in
//   the last row), and a parallel array of (model index, flags).
//
// Every section is a run of arrays, each prefixed by its element size and count.
// Which array is which is recognised by shape rather than by position, and a
// file whose shape does not match returns null rather than guessing: the format
// carries a version per section and the reading below was established on
// Prokhorovka, Mountain Pass and Pilsen from 1.21 to 2.4.

/** One placed object: its model family and where it stands, in metres. */
export type PlacedObject = { model: string; x: number; y: number; z: number };

type Section = { offset: number; length: number };
type ArrayView = { at: number; size: number; count: number };

function sections(buf: Buffer): Map<string, Section> {
  const out = new Map<string, Section>();
  if (buf.toString("latin1", 0, 4) !== "BWTB") return out;
  for (let i = 1; i < 64; i++) {
    const at = i * 24;
    const tag = buf.toString("latin1", at, at + 4);
    if (!/^[A-Za-z0-9]{4}$/.test(tag)) break;
    out.set(tag, { offset: Number(buf.readBigUInt64LE(at + 8)), length: Number(buf.readBigUInt64LE(at + 16)) });
  }
  return out;
}

function arrays(buf: Buffer, section: Section): ArrayView[] {
  const out: ArrayView[] = [];
  let p = section.offset;
  const end = section.offset + section.length;
  while (p + 8 <= end) {
    const size = buf.readUInt32LE(p);
    const count = buf.readUInt32LE(p + 4);
    if (size * count > end - p - 8) break;
    out.push({ at: p + 8, size, count });
    p += 8 + size * count;
  }
  return out;
}

function strings(buf: Buffer, section: Section): Map<number, string> {
  const out = new Map<number, string>();
  const count = buf.readUInt32LE(section.offset + 4);
  const entries = section.offset + 8;
  const blobLength = entries + count * 12;
  const blob = blobLength + 4;
  if (blob + buf.readUInt32LE(blobLength) > buf.length) return out;
  for (let i = 0; i < count; i++) {
    const e = entries + i * 12;
    const offset = buf.readUInt32LE(e + 4);
    out.set(buf.readUInt32LE(e), buf.toString("latin1", blob + offset, blob + offset + buf.readUInt32LE(e + 8)));
  }
  return out;
}

/** `content/Buildings/hd_bld_SU_201_VHouse/normal/lod0/X.primitives` ->
 * `content/Buildings/hd_bld_SU_201_VHouse`: the family, which every lod and
 * variant of one model shares. */
function family(path: string): string {
  return path.replace(/\/(?:normal|destroyed|crash)\/.*$/, "").replace(/\/[^/]*\.primitives$/, "");
}

export function placedObjects(buf: Buffer): PlacedObject[] | null {
  const table = sections(buf);
  const st = table.get("BWST");
  const mi = table.get("BSMI");
  const mo = table.get("BSMO");
  if (!st || !mi || !mo) return null;
  const names = strings(buf, st);
  const models = arrays(buf, mo).find((a) => a.size === 36);
  const instances = arrays(buf, mi);
  const transforms = instances.find((a) => a.size === 64);
  if (!models || !transforms) return null;
  const modelNames: string[] = [];
  let named = 0;
  for (let i = 0; i < models.count; i++) {
    const name = names.get(buf.readUInt32LE(models.at + i * 36 + 24));
    if (name) named++;
    modelNames.push(name ? family(name) : "?");
  }
  if (named < models.count / 2) return null;
  // The (model index, flags) array: as many entries as transforms, and every
  // index inside the model table. The other 8-byte array of the same length
  // holds flags far above it.
  const index = instances.find((a) => {
    if (a.size !== 8 || a.count !== transforms.count) return false;
    for (let i = 0; i < a.count; i++) if (buf.readUInt32LE(a.at + i * 8) >= models.count) return false;
    return true;
  });
  if (!index) return null;
  const out: PlacedObject[] = [];
  for (let i = 0; i < transforms.count; i++) {
    const t = transforms.at + i * 64;
    out.push({
      model: modelNames[buf.readUInt32LE(index.at + i * 8)],
      x: buf.readFloatLE(t + 48),
      y: buf.readFloatLE(t + 52),
      z: buf.readFloatLE(t + 56),
    });
  }
  return out;
}
