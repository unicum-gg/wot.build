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
import { nameFor } from "./localization.js";
import { decodePacked, type PackedNode } from "./packed.js";
import { DECAL_SCALE_FACTORS, readDecals, readProjectionDecals, type StyleDecal, type StyleProjectionDecal } from "./decal.js";
import { readPaints, regionsOf, repaint, StylePart, type StylePaint } from "./paint.js";
import { offeredOn, readCamouflages, type CamouflageColor } from "./camouflage.js";
import { readInsignia } from "./insignia.js";
import { type VehicleIdentity } from "./identity.js";
import { child, children, text } from "./read.js";

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

function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value;
  if (typeof node.value === "number") return [node.value];
  return text(node)
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
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
/**
 * What each 3D style is called, by the model set it swaps in.
 *
 * A 3D style lives in the same customization files as a 2D one and is told
 * apart by its `c11n3D` tag. `modelsSet` is exactly the folder the mirror
 * publishes it under, `A120_M48A5_3DSt_TLXXL`, and `userString` is the key the
 * game shows a player. Without this a wardrobe offers folder names.
 *
 * Keyed by the model set rather than by vehicle: a style names one set and the
 * set is unique, so one table serves the whole catalogue.
 */
/** What a 3D style is called and what the client pictures it with. */
export type SkinFace = { name: string; icon: string };

/**
 * Every 3D style, by the folder of models it dresses a vehicle in.
 *
 * **The picture is read, never guessed from the folder.** A style's folder is
 * whatever the artist called the set, and a third of them are named after the
 * occasion rather than the style: `battlepass2020` is "Storm", `halloween` is
 * "Revenant", `SD` is "Immortal Classics". The catalogue names the swatch
 * itself, in the same `texture` node a 2D style uses, so it is taken from there
 * like everything else here.
 */
export function readSkinNames(root: string, names: Map<string, string>): Record<string, SkinFace> {
  const dir = path.join(root, "styles");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, SkinFace> = {};
  for (const file of fs.readdirSync(dir).sort()) {
    for (const style of everyStyle(decodePacked(fs.readFileSync(path.join(dir, file))))) {
      if (!text(child(style, "tags")).split(/\s+/).includes("c11n3D")) continue;
      const set = text(child(style, "modelsSet"));
      const key = text(child(style, "userString"));
      if (!set || out[set]) continue;
      const named = nameFor(key, names);
      // A key the catalogue has nothing for resolves to itself, and a folder
      // name is no better than the one the reader already had.
      if (named && named !== key) out[set] = { name: named, icon: text(child(style, "texture")) };
    }
  }
  return out;
}

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
