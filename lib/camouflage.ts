// The 2D camouflages a player can paint on a vehicle.
//
// A camouflage is not a texture laid over the model. It is a **four channel
// weight map plus a palette**: each channel of the pattern selects one of four
// colours, and the four weights blend between them across the surface. That is
// why a single pattern file serves a whole family of camouflages, one per
// palette, and why the client ships far fewer patterns than items.
//
// Where it lands is per vehicle. The client stores a `tiling` entry for every
// vehicle a camouflage is offered on, hand tuned, so the pattern reads at the
// right size on a scout and on a heavy alike.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import { child, text, words } from "./read.js";

/** One of the four colours a pattern's channels select between. */
export type CamouflageColor = { r: number; g: number; b: number; a: number };

export type Camouflage = {
  id: number;
  /** The client's localisation key, `#vehicle_customization:...`. */
  name: string;
  /** `winter`, `summer`, `desert`, or `ALL` for one that fits any map. */
  season: string;
  /** The pattern, as the client paths it. */
  texture: string;
  /** One entry per colour scheme the player can pick, four colours each. */
  palettes: CamouflageColor[][];
  /**
   * The three sizes the pattern can be laid at, smallest last.
   *
   * A player picks one in the garage and a preset style names one, so this is
   * a multiplier on the tiling rather than a size in its own right.
   */
  scales: number[];
  /** How the pattern is laid on this vehicle: scale then offset, in UV. */
  tiling: [number, number, number, number];
  /**
   * **Which of the client's two tiling paths this camouflage takes.**
   *
   * A camouflage that lists a tiling for the vehicle by hand takes the legacy
   * path, where `tiling` is the answer. One that does not is computed from its
   * factor, the pattern's own pixel size, the vehicle's length and the piece's
   * density. The two are not variants of one formula and the numbers are not
   * interchangeable: reading a `relativeWithFactor` factor as if it were a
   * hand-tuned tiling is what put "Come Get Some!" at the wrong size.
   */
  tuned: boolean;
  /** `absolute`, `relative` or `relativewithfactor`, as the client spells it. */
  tilingType: string;
  factor: [number, number];
  offset: [number, number];
  /**
   * How far the pattern is turned on each part, in radians.
   *
   * Present on 1902 of the client's 3264 camouflages, and it is what makes a
   * pattern run diagonally across a hull rather than square to its UVs. It
   * turns the tiled coordinate, so it turns the whole lay rather than each tile.
   */
  rotation: Partial<Record<string, number>>;
  /**
   * **How each of the four colours finishes**, since a camouflage is a coat of
   * paint and not a sticker: one gloss and one metallic per palette entry, the
   * client's own 0.509 and 0.23 where it says nothing. It is what tells a matt
   * green from a lacquered one under the same pattern.
   */
  gloss: [number, number, number, number];
  metallic: [number, number, number, number];
  /**
   * A map that overrides both per pixel, gloss in red and metallic in green.
   * 274 of the client's 3264 camouflages carry one, and they are the ones a
   * player buys for the finish rather than the pattern.
   */
  glossMetallicMap: string | null;
  /** A relief laid over the vehicle's own, on 22 of them. */
  normal: { texture: string; strength: number } | null;
  /** What glows, on the two that glow. */
  emission: { texture: string; power: number } | null;
  /** Who the client offers it to. Empty on both sides means everyone. */
  filter: { include: FilterClause[]; exclude: FilterClause[] };
};

/** One line of a vehicle filter. Everything it names has to match at once. */
export type FilterClause = {
  nations: string[];
  vehicles: string[];
  tags: string[];
  levels: number[];
};

/** The client writes vectors as text, and drops to a real array for some. */
function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value;
  if (typeof node.value === "number") return [node.value];
  return text(node)
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** One value per palette colour, filled out from the client's own default. */
function four(values: number[], fallback: number): [number, number, number, number] {
  return [0, 1, 2, 3].map((i) => (Number.isFinite(values[i]) ? values[i] : fallback)) as [number, number, number, number];
}

function relief(node: PackedNode | undefined): { texture: string; strength: number } | null {
  const texture = text(child(node, "normalMap"));
  return texture ? { texture, strength: Number(child(node, "normalStrength")?.value ?? 1) || 1 } : null;
}

function glow(node: PackedNode | undefined): { texture: string; power: number } | null {
  const texture = text(child(node, "emission_texture"));
  return texture ? { texture, power: Number(child(node, "emission_deferred_power")?.value ?? 1) || 1 } : null;
}

function readClause(node: PackedNode): FilterClause {
  return {
    nations: words(child(node, "nations")),
    vehicles: words(child(node, "vehicles")),
    tags: words(child(node, "tags")),
    levels: numbers(child(node, "levels")),
  };
}

/**
 * Whether one clause covers a vehicle.
 *
 * A clause lists several kinds of criteria and the vehicle has to answer all of
 * them, so a clause naming a nation and a tier means that nation at that tier.
 */
export function clauseCovers(clause: FilterClause, vehicle: { nation: string; key: string; level: number; tags: string[] }): boolean {
  if (clause.nations.length > 0 && !clause.nations.includes(vehicle.nation)) return false;
  if (clause.vehicles.length > 0 && !clause.vehicles.includes(vehicle.key)) return false;
  if (clause.levels.length > 0 && !clause.levels.includes(vehicle.level)) return false;
  if (clause.tags.length > 0 && !clause.tags.some((t) => vehicle.tags.includes(t))) return false;
  return true;
}

/** Whether the client offers this camouflage on this vehicle at all. */
export function offeredOn(camo: Camouflage, vehicle: { nation: string; key: string; level: number; tags: string[] }): boolean {
  if (camo.filter.exclude.some((c) => clauseCovers(c, vehicle))) return false;
  return camo.filter.include.length === 0 || camo.filter.include.some((c) => clauseCovers(c, vehicle));
}

function readColor(node: PackedNode): CamouflageColor {
  const [r = 0, g = 0, b = 0, a = 255] = numbers(node);
  return { r, g, b, a };
}

function readOne(group: PackedNode, camo: PackedNode, code: string): Camouflage {
  // **The per-vehicle tiling is an override, not the rule.** `tilingSettings`
  // carries the size the pattern is laid at on any vehicle, and the `tiling`
  // list beside it holds the ones WG tuned by hand. Reading only the list drops
  // every camouflage that was never tuned, which is most of them: on the IS-7
  // it left 11 styles standing out of several hundred.
  const settings = child(camo, "tilingSettings");
  const [fx = 1, fy = 1] = numbers(child(settings, "factor"));
  const [dx = 0, dy = 0] = numbers(child(settings, "offset"));
  const mine = child(child(camo, "tiling"), code);
  const [u = fx, v = fy, offsetU = dx, offsetV = dy] = numbers(mine);
  return {
    id: Number(child(camo, "id")?.value ?? 0),
    name: text(child(camo, "userString")),
    season: text(child(group, "season")) || "ALL",
    texture: text(child(camo, "texture")),
    palettes: (child(camo, "palettes")?.children ?? []).map((p) => p.children.map(readColor)),
    scales: numbers(child(camo, "scales")),
    tiling: [u, v, offsetU, offsetV],
    tuned: mine !== undefined,
    tilingType: text(child(settings, "type")).toLowerCase(),
    factor: [fx, fy],
    offset: [dx, dy],
    rotation: Object.fromEntries(
      (child(camo, "rotation")?.children ?? []).map((part) => [part.name.toLowerCase(), Number(part.value) || 0]),
    ),
    // The client's own defaults, which is what it uses for the camouflages that
    // name neither. Both are written one value per palette colour.
    gloss: four(numbers(child(camo, "gloss")), 0.509),
    metallic: four(numbers(child(camo, "metallic")), 0.23),
    glossMetallicMap: text(child(camo, "glossMetallicMap")) || null,
    normal: relief(child(camo, "normal")),
    emission: glow(child(camo, "emission")),
    filter: {
      include: (child(group, "vehicleFilter")?.children ?? []).filter((c) => c.name === "include").map(readClause),
      exclude: (child(group, "vehicleFilter")?.children ?? []).filter((c) => c.name === "exclude").map(readClause),
    },
  };
}

/** Every camouflage the client offers on one vehicle, read from one folder. */
export function readCamouflages(dir: string, code: string): Camouflage[] {
  const out: Camouflage[] = [];
  const seen = new Set<number>();
  for (const file of fs.readdirSync(dir).sort()) {
    const root = decodePacked(fs.readFileSync(path.join(dir, file)));
    for (const group of root.children.filter((c) => c.name === "itemGroup")) {
      for (const node of group.children.filter((c) => c.name === "camouflage")) {
        const camo = readOne(group, node, code);
        // The nation files and the shared ones overlap, and an id is an id.
        if (seen.has(camo.id)) continue;
        seen.add(camo.id);
        out.push(camo);
      }
    }
  }
  return out;
}
