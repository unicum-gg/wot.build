// Which part of a vehicle takes which colour.
//
// A vehicle is four parts and each has four regions, so a style addresses any of
// them with one sixteen-bit mask. The colours themselves come from the paints
// the client defines, and the rule for filling the regions a style leaves unnamed
// is the client's own.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import type { CamouflageColor } from "./camouflage.js";

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
import { child, children, text } from "./read.js";

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
export function regionsOf(mask: number): Partial<Record<StylePart, number>> {
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
export function repaint<T>(paints: StylePaint[], take: (paint: StylePaint) => T): Partial<Record<StylePart, T[]>> {
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

/** Every paint the client defines, by id. */
export function readPaints(dir: string): Map<number, { color: CamouflageColor; gloss: number; metallic: number }> {
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
