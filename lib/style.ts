// The 2D styles a player can put on a vehicle.
//
// A 2D style is not a model and not a texture: it is a **named preset**, one
// the client assembles out of the same pieces a player could pick by hand. It
// names a camouflage with a palette, one or more paints, and decals, and says
// for each which part of the vehicle it lands on. So "Aquino" and "Aurora
// Borealis" are recipes, and everything they refer to already exists elsewhere
// in the customization data.
//
// This resolves the whole recipe at build time, so a viewer is handed colours
// and a pattern rather than a pile of ids to chase.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import { offeredOn, readCamouflages, type CamouflageColor } from "./camouflage.js";
import { readInsignia } from "./insignia.js";
import { type VehicleIdentity } from "./script.js";

/**
 * The four parts of a vehicle a style paints, in the order the client's
 * `appliedTo` mask counts them. Each part owns four bits, one per region of it
 * that can be painted separately.
 */
export enum StylePart {
  Chassis = "chassis",
  Hull = "hull",
  Turret = "turret",
  Gun = "gun",
}

const PART_ORDER = [StylePart.Chassis, StylePart.Hull, StylePart.Turret, StylePart.Gun];
const REGIONS_PER_PART = 4;

/**
 * The gun region that inherits nothing.
 *
 * The client calls it `C11N_MASK_REGION` and it is `GUN_2`, the muzzle. Every
 * other region falls back to the first region's colour when no paint names it;
 * this one falls back to the vehicle's default colour instead, which is why a
 * muzzle brake stays in the tank's own green under a style that repaints the
 * rest of the barrel.
 */
const GUN_MASK_REGION = 2;

export type StylePaint = {
  color: CamouflageColor;
  gloss: number;
  metallic: number;
  regions: Partial<Record<StylePart, number>>;
};

export type StyleCamouflage = {
  /** The pattern, as the client paths it. */
  texture: string;
  /**
   * Scale then offset in the model's own UV, but **only when the client tuned
   * one by hand for this vehicle**. Null otherwise, and then the viewer works
   * it out from the factor below, the pattern's pixel size, the vehicle's
   * length and the piece's own density.
   */
  tiling: [number, number, number, number] | null;
  /** What the computed path needs when there is no hand-tuned tiling. */
  tilingType: string;
  factor: [number, number];
  offset: [number, number];
  /** The size the style asks the pattern to be laid at. */
  scale: number;
  /** How far the pattern is turned on each part, in radians. */
  rotation: Partial<Record<string, number>>;
  /** The pattern's own pixel size, filled in when it is published. */
  size?: [number, number] | null;
  /**
   * How many of the pattern's channels are weights, filled in when it is
   * published. Three where its alpha is padding, and then the palette's fourth
   * colour is not laid at all.
   */
  weights?: 3 | 4;
  /** The four colours the pattern's channels select between. */
  colors: CamouflageColor[];
  /**
   * How each of those four colours finishes, and the maps that override it.
   *
   * A camouflage is a coat of paint rather than a sticker, so it carries its own
   * gloss and metal. Without these every style renders in the vehicle's own
   * finish, which is what made the lacquered and the metallic ones read flat.
   */
  gloss: [number, number, number, number];
  metallic: [number, number, number, number];
  glossMetallicMap: string | null;
  normal: { texture: string; strength: number } | null;
  emission: { texture: string; power: number } | null;
  regions: Partial<Record<StylePart, number>>;
};

/**
 * A sticker or a line of lettering, projected into one of the vehicle's own
 * decal slots.
 *
 * Which slot it lands in comes from what it is rather than from where it is
 * pointed: the client keeps emblem slots and inscription slots apart on every
 * vehicle, and an emblem goes in an emblem slot.
 */
export type StyleDecal = {
  texture: string;
  /** `emblem` or `inscription`, read from the key the client names it under. */
  kind: string;
  /** Whether the client mirrors it onto the vehicle's other side. */
  mirror: boolean;
  regions: Partial<Record<StylePart, number>>;
};

/**
 * A decal projected into one of the vehicle's own projection slots.
 *
 * Unlike an emblem, which the client places by casting a ray, this one carries
 * a box: the slot says where it sits, how it is turned and how big, and the
 * item says which slots it may go in by naming their tags. `safe left
 * formfactor_square` picks out one place on a vehicle and no other.
 */
export type StyleProjectionDecal = {
  texture: string;
  /** The tags a slot must all carry for this to go in it. */
  tags: string[];
  /** One of the client's three sizes, already resolved. */
  scale: number;
  mirror: boolean;
};

export type StyleOutfit = {
  season: string;
  /**
   * **A style can wear more than one camouflage**, a different pattern per
   * part: 135 of the client's 3134 outfits do, and one of them dresses a hull,
   * a turret and a gun in three. Reading only the first left the rest of the
   * vehicle in flat paint.
   */
  camouflages: StyleCamouflage[];
  paints: StylePaint[];
  decals: StyleDecal[];
  projected: StyleProjectionDecal[];
  /**
   * What colour each of the four regions of each part is repainted.
   *
   * **A style repaints the whole vehicle, not only what it names.** The client
   * starts every region at the vehicle's default colour, lets a paint override
   * the regions it names, and has the rest inherit the first region's colour.
   * A camouflage on its own is enough to turn the repaint on. Painting only the
   * named regions left a gun mantlet and a muzzle brake in the tank's own paint
   * under a style that had covered everything else.
   */
  regionColors: Partial<Record<StylePart, CamouflageColor[]>>;
  /**
   * How each of those regions finishes, since a paint is a paint and not a
   * tint: the client keeps a gloss and a metallic beside every colour, and 534
   * of a vehicle's 741 styles carry one. Without them a lacquered coat and a
   * matt one render identically.
   */
  regionFinish: Partial<Record<StylePart, { gloss: number; metallic: number }[]>>;
  /**
   * The marks of excellence this style wears instead of the national ones.
   *
   * A style can bring its own, and hundreds do. It is the same three files
   * under a different name, so the vehicle keeps its slot on the gun and only
   * the picture changes. Empty when the style leaves the nation's own.
   */
  marks: string[];
};

export type Style2D = {
  id: number;
  /** The client's localisation key. Its last part is the style's own name. */
  name: string;
  /** The style's own picture, as the client paths it. */
  icon: string;
  outfits: StyleOutfit[];
};

function child(node: PackedNode | undefined, name: string): PackedNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function children(node: PackedNode | undefined, name: string): PackedNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

function text(node: PackedNode | undefined): string {
  return typeof node?.value === "string" ? node.value.trim() : "";
}

function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value;
  if (typeof node.value === "number") return [node.value];
  return text(node)
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/**
 * Which regions of which parts a mask lands on.
 *
 * **A part is not the unit.** Every piece is divided into up to four regions by
 * its own colour-id map, and `appliedTo` names regions rather than parts: a
 * camouflage that reads "hull, turret, gun" is usually region 1 of each. On a
 * piece whose map is the shared blank one that is the whole piece, which is why
 * reading it as parts looked right on a hull and left a gun barrel unpainted:
 * the gun is the one piece with a map of its own, and its barrel is a region of
 * its own within it.
 */
function regionsOf(mask: number): Partial<Record<StylePart, number>> {
  const out: Partial<Record<StylePart, number>> = {};
  PART_ORDER.forEach((part, at) => {
    const bits = (mask >> (at * REGIONS_PER_PART)) & ((1 << REGIONS_PER_PART) - 1);
    if (bits !== 0) out[part] = bits;
  });
  return out;
}


/**
 * What every region of every part ends up painted.
 *
 * The rule is the client's own: a paint covers the regions it names and the
 * rest take the first region's colour. The gun's mask region is the one
 * exception and takes nothing.
 *
 * **An unpainted region stays unpainted.** The client fills it with the
 * nation's default and so did this, which is right for a client whose albedo is
 * authored neutral and wrong for ours, where the vehicle's own colour is
 * already in the texture: painting the default over it a second time turned
 * every French running gear a flat blue-grey under styles that carry no paint
 * at all. A region with no paint is returned with a zero alpha and the surface
 * keeps what it came with.
 */
function repaint<T>(paints: StylePaint[], take: (paint: StylePaint) => T): Partial<Record<StylePart, T[]>> {
  // What a region with no paint gets. The colour reads as fully transparent, so
  // nothing is laid; the finish is the client's own default, which is what the
  // surface keeps when nothing paints over it.
  const bare = take({ color: { r: 0, g: 0, b: 0, a: 0 }, gloss: 0.509, metallic: 0.23, regions: {} });
  const out: Partial<Record<StylePart, T[]>> = {};
  for (const part of PART_ORDER) {
    const named = (region: number) => {
      const paint = paints.find((p) => ((p.regions[part] ?? 0) >> region) & 1);
      return paint?.color ? take(paint) : undefined;
    };
    const first = named(0) ?? bare;
    out[part] = [0, 1, 2, 3].map(
      (region) => named(region) ?? (part === StylePart.Gun && region === GUN_MASK_REGION ? bare : first),
    );
  }
  return out;
}

/** Every decal the client defines, by id. */
function readDecals(dir: string): Map<number, { texture: string; kind: string; mirror: boolean }> {
  const out = new Map<number, { texture: string; kind: string; mirror: boolean }>();
  if (!fs.existsSync(dir)) return out;
  const every = (node: PackedNode, into: PackedNode[] = []): PackedNode[] => {
    for (const c of node.children) {
      if (c.name === "decal") into.push(c);
      else every(c, into);
    }
    return into;
  };
  for (const file of fs.readdirSync(dir).sort()) {
    for (const decal of every(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      const id = Number(child(decal, "id")?.value ?? 0);
      const texture = text(child(decal, "texture"));
      if (!id || !texture || out.has(id)) continue;
      // The key says what it is: `#vehicle_customization:emblem/...` against
      // `#vehicle_customization:inscription/...`. Nothing else in the entry
      // does, and the two go in different slots.
      const key = text(child(decal, "userString"));
      out.set(id, {
        texture,
        kind: key.includes("inscription") ? "inscription" : "emblem",
        mirror: child(decal, "mirror")?.value === true || text(child(decal, "mirror")) === "true",
      });
    }
  }
  return out;
}

/** The three sizes a projection decal can be asked for, as the client lists them. */
const DECAL_SCALE_FACTORS = [0.6, 0.8, 1.0];

/** Every projection decal the client defines, by id. */
function readProjectionDecals(dir: string): Map<number, { texture: string; mirror: boolean }> {
  const out = new Map<number, { texture: string; mirror: boolean }>();
  if (!fs.existsSync(dir)) return out;
  const every = (node: PackedNode, into: PackedNode[] = []): PackedNode[] => {
    for (const c of node.children) {
      if (c.name === "projection_decal") into.push(c);
      else every(c, into);
    }
    return into;
  };
  for (const file of fs.readdirSync(dir).sort()) {
    for (const decal of every(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      const id = Number(child(decal, "id")?.value ?? 0);
      const texture = text(child(decal, "texture"));
      if (!id || !texture || out.has(id)) continue;
      out.set(id, { texture, mirror: child(decal, "mirror")?.value === true || text(child(decal, "mirror")) === "true" });
    }
  }
  return out;
}

/** Every paint the client defines, by id. */
function readPaints(dir: string): Map<number, { color: CamouflageColor; gloss: number; metallic: number }> {
  const out = new Map<number, { color: CamouflageColor; gloss: number; metallic: number }>();
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).sort()) {
    const root = decodePacked(fs.readFileSync(path.join(dir, file)));
    for (const group of root.children) {
      for (const paint of children(group, "paint")) {
        const id = Number(child(paint, "id")?.value ?? 0);
        if (!id || out.has(id)) continue;
        const [r = 0, g = 0, b = 0, a = 255] = numbers(child(paint, "color"));
        out.set(id, {
          color: { r, g, b, a },
          gloss: Number(text(child(paint, "gloss")) || 0),
          metallic: Number(text(child(paint, "metallic")) || 0),
        });
      }
    }
  }
  return out;
}

/** Walk to every `<style>`, wherever a file nests it. */
function everyStyle(node: PackedNode, into: PackedNode[] = []): PackedNode[] {
  for (const c of node.children) {
    if (c.name === "style") into.push(c);
    else everyStyle(c, into);
  }
  return into;
}

/**
 * The 2D styles offered on one vehicle, with everything they name resolved.
 *
 * A style carries no vehicle filter of its own: what decides is the camouflage
 * inside it, which only lists a tiling for the vehicles it is drawn for. So a
 * style whose camouflage says nothing about this vehicle is not offered on it.
 */
export function readStyles(root: string, vehicle: VehicleIdentity): Style2D[] {
  const camouflages = new Map(
    readCamouflages(path.join(root, "camouflages"), vehicle.key.split(":")[1])
      // A style carries no filter of its own, so what decides whether it is
      // offered here is the camouflage inside it saying so.
      .filter((c) => offeredOn(c, vehicle))
      .map((c) => [c.id, c]),
  );
  const paints = readPaints(path.join(root, "paints"));
  const decals = readDecals(path.join(root, "decals"));
  const projections = readProjectionDecals(path.join(root, "projection_decals"));
  const dir = path.join(root, "styles");
  if (!fs.existsSync(dir)) return [];

  const out: Style2D[] = [];
  const seen = new Set<string>();
  for (const file of fs.readdirSync(dir).sort()) {
    for (const style of everyStyle(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      const tags = text(child(style, "tags")).split(/\s+/);
      // A 3D style is a set of models and is offered elsewhere. `hiddenInUI` is
      // the client saying it keeps this one for its own reasons.
      if (!tags.includes("c11n2D") || tags.includes("hiddenInUI")) continue;
      const id = Number(child(style, "id")?.value ?? 0);
      // Deduplicated by name, not by id: the client lists the same style once
      // per region and once per tier bracket, four `gold_style_01` among them,
      // and a player sees one entry.
      const name = text(child(style, "userString"));
      if (!id || seen.has(name)) continue;

      const outfits: StyleOutfit[] = [];
      for (const outfit of children(child(style, "outfits"), "outfit")) {
        const items = children(child(outfit, "camouflages"), "item");
        const named = items.map((item) => ({ item, source: camouflages.get(Number(child(item, "id")?.value ?? 0)) }));
        // A style is only as available as the camouflages it names.
        if (named.some(({ source }) => !source)) continue;
        // **Camouflage id 1 is the empty one.** It carries no pattern, and a
        // style naming it is saying it has no camouflage rather than that it is
        // broken: "Aquino" is a paint and two decals, and reading the empty
        // camouflage as a missing one dropped it and every style like it.
        const patterns = named.filter(({ source }) => source?.texture);
        const paint = children(child(outfit, "paints"), "item")
          .map((entry) => {
            const found = paints.get(Number(child(entry, "id")?.value ?? 0));
            return found ? { ...found, regions: regionsOf(Number(child(entry, "appliedTo")?.value ?? 0)) } : null;
          })
          .filter((p): p is StylePaint => p !== null);
        const sticker = children(child(outfit, "decals"), "item")
          .map((entry) => {
            const found = decals.get(Number(child(entry, "id")?.value ?? 0));
            return found ? { ...found, regions: regionsOf(Number(child(entry, "appliedTo")?.value ?? 0)) } : null;
          })
          .filter((d): d is StyleDecal => d !== null);
        const projected = children(child(outfit, "projection_decals"), "item")
          .map((entry) => {
            const found = projections.get(Number(child(entry, "id")?.value ?? 0));
            if (!found) return null;
            // **`scaleFactorId` counts from one.** The client's own default is
            // 3 for a list of three, which only makes sense that way, and
            // taking it as an index left every decal a quarter too big.
            const which = Number(child(entry, "scaleFactorId")?.value ?? DECAL_SCALE_FACTORS.length);
            return {
              ...found,
              tags: text(child(entry, "tags")).split(/\s+/).filter(Boolean),
              scale: DECAL_SCALE_FACTORS[which - 1] ?? 1,
            };
          })
          .filter((d): d is StyleProjectionDecal => d !== null);
        if (patterns.length === 0 && paint.length === 0 && sticker.length === 0 && projected.length === 0) continue;
        outfits.push({
          season: text(child(outfit, "season")) || "ALL",
          camouflages: patterns.map(({ item, source }) => wear(source!, item)),
          paints: paint,
          regionColors: repaint(paint, (p) => p.color),
          regionFinish: repaint(paint, (p) => ({ gloss: p.gloss, metallic: p.metallic })),
          decals: sticker,
          projected,
          marks: readInsignia(root, Number(child(child(outfit, "insignias")?.children[0], "id")?.value ?? 0)),
        });
      }
      if (outfits.length === 0) continue;
      seen.add(name);
      out.push({
        id,
        name,
        icon: text(child(style, "texture")),
        outfits,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fold a style's choice of palette and pattern size into the camouflage. */
function wear(source: ReturnType<typeof readCamouflages>[number], item: PackedNode): StyleCamouflage {
  const palette = Number(child(item, "palette")?.value ?? 0);
  // `patternSize` picks one of the three scales the camouflage ships, which is
  // the same choice a player makes by hand in the garage.
  const size = Number(child(item, "patternSize")?.value ?? 1);
  const scale = source.scales[Math.min(Math.max(size, 0), source.scales.length - 1)] ?? 1;
  return {
    texture: source.texture,
    // The hand-tuned tiling, already carrying the size the style asks for. The
    // piece's own coefficient is applied by the viewer, which is where the
    // piece is known.
    tiling: source.tuned ? [source.tiling[0] * scale, source.tiling[1] * scale, source.tiling[2], source.tiling[3]] : null,
    tilingType: source.tilingType,
    factor: source.factor,
    offset: source.offset,
    scale,
    rotation: source.rotation,
    colors: source.palettes[Math.min(palette, source.palettes.length - 1)] ?? [],
    gloss: source.gloss,
    metallic: source.metallic,
    glossMetallicMap: source.glossMetallicMap,
    normal: source.normal,
    emission: source.emission,
    regions: regionsOf(Number(child(item, "appliedTo")?.value ?? 0)),
  };
}

/**
 * The marks a 3D style wears, by the folder the client publishes its pieces in.
 *
 * A 3D style is offered elsewhere and is not read as a recipe, but it can still
 * replace the mark on the gun. The style's own name is what ties the two
 * together: `R45_IS-7_BPXVIII_3Dst` is both the folder and the last part of the
 * key the style names itself with.
 */
export function readSkinMarks(root: string, skin: string): string[] {
  const dir = path.join(root, "styles");
  if (!fs.existsSync(dir)) return [];
  for (const file of fs.readdirSync(dir).sort()) {
    for (const style of everyStyle(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      if (text(child(style, "userString")).split("/").pop() !== skin) continue;
      for (const outfit of children(child(style, "outfits"), "outfit")) {
        const marks = readInsignia(root, Number(child(child(outfit, "insignias")?.children[0], "id")?.value ?? 0));
        if (marks.length > 0) return marks;
      }
    }
  }
  return [];
}
