// What changed in a map between two versions, from their snapshots, and the
// overlays that draw it on the minimap.
//
// Three readings, each answering "where" rather than "how many bytes":
//
// - The relief: heights compared point by point (one vertex every ~1.5 m) and
//   rasterised over the minimap, red where the ground rose and blue where it
//   sank. Measured on Prokhorovka, a cell can be rewritten for a few
//   centimetres of smoothing, so a change only counts past 25 cm, and over a
//   map reworked end to end (Pilsen at 2.4.0 moved most of its ground, by up to
//   60 m) everything would be coloured, so past 40% of the play area only what
//   moved more than 2 m is drawn.
// - The objects: the placed models before and after, matched by model and
//   position. One nudged by a metre is the same object, so leftovers of one
//   model within 3 m of each other pair off before anything is called built or
//   pulled down.
// - The rest, read from which package entries changed: the sky and lighting,
//   the sound zones, the water, the effects, the vegetation, the models and
//   textures, and ground repainted without being reshaped (four cells or more).
import fs from "node:fs";
import sharp from "sharp";
import type { MapSnapshot, TerrainCell } from "./map-snapshot.js";
import type { PlacedObject } from "./space-bin.js";

/** The play area, in world metres: the extent the minimap covers. */
export type Bounds = { x0: number; z0: number; x1: number; z1: number };

export enum ObjectKind {
  Buildings = "buildings",
  Fences = "fences",
  Rocks = "rocks",
  Military = "military",
  Bridges = "bridges",
  Vegetation = "vegetation",
  Props = "props",
}

export enum MapAspect {
  Ground = "ground",
  Sky = "sky",
  Sound = "sound",
  Water = "water",
  Effects = "effects",
  Vegetation = "vegetation",
  Models = "models",
}

export type ReliefChange = {
  /** Highest rise and deepest drop, in metres (drop positive). */
  rise: number;
  drop: number;
  /** Square metres that moved past `threshold`. */
  area: number;
  /** Metres: 0.25, or 2 when the map was reshaped end to end. */
  threshold: number;
  /** Even past 2 m most of the map moved: the minimap before and after says
   * more than a sheet of colour, so no overlay is drawn. */
  rebuilt: boolean;
};

export type ObjectsChange = {
  added: Partial<Record<ObjectKind, number>>;
  removed: Partial<Record<ObjectKind, number>>;
  /** Most of the map's objects were replaced, so the dots would be the whole
   * map: no overlay is drawn. */
  rebuilt: boolean;
};

export type MapDiff = {
  relief: ReliefChange | null;
  objects: ObjectsChange | null;
  aspects: MapAspect[];
};

const RELIEF_MIN = 0.25;
const RELIEF_REWORK = 2;
const REWORK_SHARE = 0.4;
/** Below this the relief is a touch-up, not something to draw. */
const RELIEF_MIN_AREA = 200;
const MATCH_RADIUS = 3;
const GROUND_MIN_CELLS = 4;
const REBUILT_SHARE = 0.6;
const RASTER = 1024;
/** Share of the play area past which the broad trend is taken out. */
const OFFSET_SHARE = 0.5;
const TREND_METRES = 100;

export function objectKind(model: string): ObjectKind | null {
  if (model.startsWith("particles/")) return null;
  if (/Tree|Bush|Shrub|Flora/i.test(model)) return ObjectKind.Vegetation;
  if (model.includes("/GatesAndFences/") || /Fence|Wall|Gate/i.test(model)) return ObjectKind.Fences;
  if (model.includes("/Bridges/") || /Bridge/i.test(model)) return ObjectKind.Bridges;
  if (model.includes("/Buildings/") || /_bld_/i.test(model)) return ObjectKind.Buildings;
  if (model.includes("/MilitaryEnvironment/") || /_mle/i.test(model)) return ObjectKind.Military;
  if (/Rock|Cliff|Stone|Boulder|Steep|Sand/i.test(model)) return ObjectKind.Rocks;
  return ObjectKind.Props;
}

/** Height of `cell` at a point inside it, bilinear over its vertices. */
function heightAt(cell: TerrainCell, u: number, v: number): number {
  // u, v in [0, 1) across the cell's visible part; vertex 2 is its south-west
  // corner and vertex size-3 its north-east one.
  const span = cell.size - 5;
  const fx = 2 + u * span;
  const fz = 2 + v * span;
  const ix = Math.min(Math.floor(fx), cell.size - 2);
  const iz = Math.min(Math.floor(fz), cell.size - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const at = (x: number, z: number) => cell.heights[z * cell.size + x];
  return (
    at(ix, iz) * (1 - tx) * (1 - tz) +
    at(ix + 1, iz) * tx * (1 - tz) +
    at(ix, iz + 1) * (1 - tx) * tz +
    at(ix + 1, iz + 1) * tx * tz
  );
}

function sameHeights(a: TerrainCell, b: TerrainCell): boolean {
  if (a.size !== b.size) return false;
  for (let i = 0; i < a.heights.length; i++) if (a.heights[i] !== b.heights[i]) return false;
  return true;
}

/** Metres of change per minimap pixel, over the cells whose heights moved. */
function reliefField(before: MapSnapshot, after: MapSnapshot, bounds: Bounds): Float32Array {
  const field = new Float32Array(RASTER * RASTER);
  const changed = new Set<string>();
  for (const [key, cell] of after.cells) {
    const old = before.cells.get(key);
    if (old && !sameHeights(old, cell)) changed.add(key);
  }
  if (changed.size === 0) return field;
  let moved = 0;
  const w = bounds.x1 - bounds.x0;
  const h = bounds.z1 - bounds.z0;
  for (let py = 0; py < RASTER; py++) {
    const wz = bounds.z1 - ((py + 0.5) / RASTER) * h;
    const cz = Math.floor(wz / 100);
    for (let px = 0; px < RASTER; px++) {
      const wx = bounds.x0 + ((px + 0.5) / RASTER) * w;
      const cx = Math.floor(wx / 100);
      const key = `${cx},${cz}`;
      if (!changed.has(key)) continue;
      const u = wx / 100 - cx;
      const v = wz / 100 - cz;
      field[py * RASTER + px] = heightAt(after.cells.get(key)!, u, v) - heightAt(before.cells.get(key)!, u, v);
      moved++;
    }
  }
  // A map reworked end to end also moves in broad strokes nobody can see from
  // a tank: Overlord at 2.0.1 sat metres higher in the west and lower in the
  // east, which drew as two solid sheets of colour over the dunes and craters
  // that actually changed. When most of the play area moved, the trend over
  // ~100 m is taken out and only the local shapes are kept.
  if (moved > RASTER * RASTER * OFFSET_SHARE) {
    const trend = boxBlur(field, Math.round((TREND_METRES / (bounds.x1 - bounds.x0)) * RASTER));
    for (let i = 0; i < field.length; i++) if (field[i] !== 0) field[i] -= trend[i];
  }
  return field;
}

/** Three passes of a separable box blur: close to a gaussian, in linear time. */
function boxBlur(source: Float32Array, radius: number): Float32Array {
  let a = Float32Array.from(source);
  let b = new Float32Array(a.length);
  const pass = (from: Float32Array, to: Float32Array, horizontal: boolean) => {
    for (let line = 0; line < RASTER; line++) {
      let sum = 0;
      let count = 0;
      const at = (i: number) => (horizontal ? line * RASTER + i : i * RASTER + line);
      for (let i = 0; i < Math.min(radius, RASTER); i++) {
        sum += from[at(i)];
        count++;
      }
      for (let i = 0; i < RASTER; i++) {
        if (i + radius < RASTER) {
          sum += from[at(i + radius)];
          count++;
        }
        if (i - radius - 1 >= 0) {
          sum -= from[at(i - radius - 1)];
          count--;
        }
        to[at(i)] = sum / count;
      }
    }
  };
  for (let n = 0; n < 3; n++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

function relief(field: Float32Array, bounds: Bounds): ReliefChange | null {
  const pixelArea = ((bounds.x1 - bounds.x0) * (bounds.z1 - bounds.z0)) / (RASTER * RASTER);
  const measure = (threshold: number) => {
    let area = 0;
    let rise = 0;
    let drop = 0;
    for (const d of field) {
      if (Math.abs(d) < threshold) continue;
      area += pixelArea;
      rise = Math.max(rise, d);
      drop = Math.max(drop, -d);
    }
    return { area, rise, drop, threshold };
  };
  let out = measure(RELIEF_MIN);
  if (out.area > REWORK_SHARE * pixelArea * RASTER * RASTER) out = measure(RELIEF_REWORK);
  if (out.area < RELIEF_MIN_AREA) return null;
  return {
    rebuilt: out.area > REWORK_SHARE * pixelArea * RASTER * RASTER,
    rise: Math.round(out.rise * 10) / 10,
    drop: Math.round(out.drop * 10) / 10,
    area: Math.round(out.area),
    threshold: out.threshold,
  };
}

const inside = (o: PlacedObject, b: Bounds) => o.x >= b.x0 && o.x <= b.x1 && o.z >= b.z0 && o.z <= b.z1;

/** The objects only one side has, after pairing off the ones that merely moved. */
export function objectDelta(
  before: PlacedObject[],
  after: PlacedObject[],
  bounds: Bounds,
): { added: PlacedObject[]; removed: PlacedObject[]; total: number } {
  const keep = (list: PlacedObject[]) => list.filter((o) => inside(o, bounds) && objectKind(o.model));
  const a = keep(before);
  const b = keep(after);
  const key = (o: PlacedObject) => `${o.model}|${Math.round(o.x)}|${Math.round(o.z)}`;
  const pool = new Map<string, PlacedObject[]>();
  for (const o of a) {
    const list = pool.get(key(o));
    if (list) list.push(o);
    else pool.set(key(o), [o]);
  }
  const added: PlacedObject[] = [];
  for (const o of b) {
    const list = pool.get(key(o));
    if (list?.length) list.pop();
    else added.push(o);
  }
  const removed = [...pool.values()].flat();
  // Pair off what moved a little: same model, within MATCH_RADIUS.
  const byModel = new Map<string, PlacedObject[]>();
  for (const o of removed) {
    const list = byModel.get(o.model);
    if (list) list.push(o);
    else byModel.set(o.model, [o]);
  }
  const stillAdded: PlacedObject[] = [];
  for (const o of added) {
    const candidates = byModel.get(o.model);
    const i = candidates?.findIndex((r) => Math.hypot(r.x - o.x, r.z - o.z) <= MATCH_RADIUS) ?? -1;
    if (candidates && i >= 0) candidates.splice(i, 1);
    else stillAdded.push(o);
  }
  return { added: stillAdded, removed: [...byModel.values()].flat(), total: a.length };
}

function countByKind(list: PlacedObject[]): Partial<Record<ObjectKind, number>> {
  const out: Partial<Record<ObjectKind, number>> = {};
  for (const o of list) {
    const kind = objectKind(o.model)!;
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

const ASPECT_RULES: [MapAspect, RegExp][] = [
  [MapAspect.Sky, /\/environments\/|skybox|skydome|\/skyboxes\//i],
  [MapAspect.Sound, /sound/i],
  [MapAspect.Water, /water/i],
  [MapAspect.Effects, /particles/i],
  [MapAspect.Vegetation, /flora|speedtree|\.ctree$|\.spt$/i],
  [MapAspect.Models, /^content\/.*\.(?:model|visual_processed|primitives_processed|dds)$/],
];

function aspects(before: MapSnapshot, after: MapSnapshot): MapAspect[] {
  const out = new Set<MapAspect>();
  const touched = new Set<string>();
  for (const [name, crc] of Object.entries(after.entries)) if (before.entries[name] !== crc) touched.add(name);
  for (const name of Object.keys(before.entries)) if (!(name in after.entries)) touched.add(name);
  for (const name of touched) {
    if (/o\.cdata_processed$|\/space\.bin$|\/mmap[^/]*\.dds$/.test(name)) continue;
    for (const [aspect, re] of ASPECT_RULES) if (re.test(name)) out.add(aspect);
  }
  let repainted = 0;
  for (const [key, cell] of after.cells) {
    const old = before.cells.get(key);
    if (old && old.blend && old.blend !== cell.blend) repainted++;
  }
  // A cell or two is repainted on most updates, along a road or a crater.
  if (repainted >= GROUND_MIN_CELLS) out.add(MapAspect.Ground);
  return [...out].sort();
}

/**
 * Compare two snapshots of one map, writing the overlays it draws (transparent
 * webp at the minimap's size) to `reliefFile` and `objectsFile` when there is
 * something to draw.
 */
export async function diffMap(
  before: MapSnapshot,
  after: MapSnapshot,
  bounds: Bounds,
  reliefFile: string,
  objectsFile: string,
): Promise<MapDiff> {
  const field = reliefField(before, after, bounds);
  const reliefChange = relief(field, bounds);
  if (reliefChange && !reliefChange.rebuilt) await drawRelief(field, reliefChange.threshold, reliefFile);
  else fs.rmSync(reliefFile, { force: true });

  let objects: ObjectsChange | null = null;
  fs.rmSync(objectsFile, { force: true });
  if (before.objects && after.objects) {
    const delta = objectDelta(before.objects, after.objects, bounds);
    if (delta.added.length + delta.removed.length > 0) {
      const rebuilt = delta.removed.length > REBUILT_SHARE * Math.max(delta.total, 1);
      objects = { added: countByKind(delta.added), removed: countByKind(delta.removed), rebuilt };
      if (!rebuilt) await drawObjects(delta.added, delta.removed, bounds, objectsFile);
    }
  }
  return { relief: reliefChange, objects, aspects: aspects(before, after) };
}

async function drawRelief(field: Float32Array, threshold: number, file: string): Promise<void> {
  const scale = Math.max(3, threshold * 4);
  const rgba = Buffer.alloc(RASTER * RASTER * 4);
  for (let i = 0; i < field.length; i++) {
    const d = field[i];
    const m = Math.abs(d);
    if (m < threshold) continue;
    const t = Math.min(1, m / scale);
    rgba[i * 4] = d > 0 ? 255 : 40;
    rgba[i * 4 + 1] = d > 0 ? 70 : 140;
    rgba[i * 4 + 2] = d > 0 ? 40 : 255;
    rgba[i * 4 + 3] = Math.round(110 + 130 * t);
  }
  await sharp(rgba, { raw: { width: RASTER, height: RASTER, channels: 4 } })
    .blur(1.5)
    .webp({ quality: 80, alphaQuality: 90 })
    .toFile(file);
}

async function drawObjects(added: PlacedObject[], removed: PlacedObject[], bounds: Bounds, file: string): Promise<void> {
  const px = (x: number) => ((x - bounds.x0) / (bounds.x1 - bounds.x0)) * RASTER;
  const pz = (z: number) => ((bounds.z1 - z) / (bounds.z1 - bounds.z0)) * RASTER;
  const dot = (o: PlacedObject, fill: string) =>
    `<circle cx="${px(o.x).toFixed(1)}" cy="${pz(o.z).toFixed(1)}" r="5" fill="${fill}" stroke="#000" stroke-width="1.5"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER}" height="${RASTER}">${removed
    .map((o) => dot(o, "#ff453a"))
    .join("")}${added.map((o) => dot(o, "#30d158")).join("")}</svg>`;
  await sharp(Buffer.from(svg)).webp({ quality: 85, alphaQuality: 90 }).toFile(file);
}
