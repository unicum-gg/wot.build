// The stickers and the lettering a 2D style puts on a vehicle.
//
// The same few hundred serve the whole catalogue, so the client keeps them under
// `gui/` rather than under a vehicle, and a style names them by id.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import { child, text } from "./read.js";
import { StylePart } from "./paint.js";

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

/** Every decal the client defines, by id. */
export function readDecals(dir: string): Map<number, { texture: string; kind: string; mirror: boolean }> {
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
export const DECAL_SCALE_FACTORS = [0.6, 0.8, 1.0];

/** Every projection decal the client defines, by id. */
export function readProjectionDecals(dir: string): Map<number, { texture: string; mirror: boolean }> {
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
