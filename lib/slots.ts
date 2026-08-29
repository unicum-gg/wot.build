// Where a vehicle takes a mark, an emblem or an inscription.
//
// The client keeps a slot per kind on every piece that can wear one, with the
// place, the facing and the size it is drawn at. Nothing in the mesh says any of
// it.
import type { PackedNode } from "./packed.js";
import { child } from "./read.js";

/** The client writes vectors as text, and drops to a real array for some. */
function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value.map(Number);
  if (typeof node.value === "number") return [node.value];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number);
  }
  return [];
}

/** What a script says about one vehicle, keyed the way the content tree is. */
/** What kind of thing a slot takes. The client's own names. */
export enum SlotKind {
  /** The marks of excellence, on the gun. */
  InsigniaOnGun = "insigniaOnGun",
  /** A clan's emblem. */
  Clan = "clan",
  /** A player's own emblem. */
  Player = "player",
  /** Painted lettering. */
  Inscription = "inscription",
  /** The projected decals a 2D style carries. */
  ProjectionDecal = "projectionDecal",
}

export type CustomizationSlot = {
  kind: string;
  id: number;
  /**
   * The ray to project along, and the decal's up vector. Slots of the older
   * kinds carry these; a projection decal carries a box instead.
   */
  rayStart: number[] | null;
  rayEnd: number[] | null;
  rayUp: number[] | null;
  /** A projection decal's own box: where it sits, how it is turned, how big. */
  position: number[] | null;
  rotation: number[] | null;
  scale: number[] | null;
  /**
   * What may go in this slot. A projection decal names the tags it needs and
   * the client puts it in a slot carrying all of them: `safe left
   * formfactor_square` picks out one place on this vehicle and no other.
   */
  tags: string[];
  /** Which part the slot shows on, as an `appliedTo` bit. */
  showOn: number;
  /** How wide the mark is, in metres. */
  size: number;
  /** Mirrored onto the vehicle's other side. */
  mirrored: boolean;
  /** Named only when the slot belongs to one 3D style rather than the vehicle. */
  model: string | null;
};

/**
 * Three angles as the client wrote them.
 *
 * **Kept unflipped on purpose.** A slot's rotation is not read as a rotation of
 * the mirrored vehicle: the axes it names are taken out of it first and each is
 * mirrored on its own. Pushing the angles through the point reader, which
 * negates X, turned a decal the wrong way and inside out.
 */
export function plain3(value: PackedNode | undefined): number[] | null {
  const raw = numbers(value);
  return raw.length >= 3 && raw.every((n) => !Number.isNaN(n)) ? raw.slice(0, 3) : null;
}

/** A point in the client's left-handed space, mirrored into ours. */
function vector3(value: PackedNode | undefined): number[] | null {
  const raw = numbers(value);
  if (!(raw.length >= 3 && raw.every((n) => !Number.isNaN(n)))) return null;
  return [-raw[0], raw[1], raw[2]];
}

export function readSlots(node: PackedNode | undefined): CustomizationSlot[] {
  const out: CustomizationSlot[] = [];
  for (const slot of node?.children ?? []) {
    const kind = String(child(slot, "slotType")?.value ?? "").trim();
    if (!kind) continue;
    const model = child(slot, "compatibleModels")?.value;
    out.push({
      kind,
      id: Number(child(slot, "slotId")?.value ?? 0),
      rayStart: vector3(child(slot, "rayStart")),
      rayEnd: vector3(child(slot, "rayEnd")),
      rayUp: vector3(child(slot, "rayUp")),
      position: vector3(child(slot, "position")),
      rotation: plain3(child(slot, "rotation")),
      scale: plain3(child(slot, "scale")),
      tags: String(child(slot, "tags")?.value ?? "").trim().split(/\s+/).filter(Boolean),
      showOn: Number(child(slot, "showOn")?.value ?? 0),
      size: Number(String(child(slot, "size")?.value ?? 0)) || 0,
      mirrored: String(child(slot, "isMirrored")?.value ?? "") === "true" || child(slot, "isMirrored")?.value === true,
      model: typeof model === "string" ? model.trim() : null,
    });
  }
  return out;
}
