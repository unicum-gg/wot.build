// What one vehicle's script says about its pieces.
//
// The meshes carry a vehicle's shape and nothing else. Two things a viewer
// cannot do without live in the script instead:
//
//  - **how high the chassis holds the hull** (`hullPosition`). A hull is
//    modelled around its own origin, which is not the ground, so a model
//    assembled from geometry alone has its hull buried in its tracks by the
//    better part of a metre.
//  - **how thick every armour plate is**. The collision mesh names its shapes
//    `armor_5` and the script says that `armor_5` is 270 mm. Neither half means
//    anything on its own, which is why they are published together.
//
// The two are found the same way, so they are read in one pass. A piece is
// recognised by the model it points at rather than by where it sits in the
// script: hull, chassis, turrets and guns all declare `models/undamaged`, and
// that path names both the piece (`Turret_01`) and the folder its content lives
// in. It is also the only reliable bridge between the two trees, which spell the
// same nation differently (`ussr` in the scripts, `russian` in the content).
import fs from "node:fs";
import path from "node:path";
import { decodePacked, isPacked, type PackedNode } from "./packed.js";
import {
  chassisSpline,
  chassisPhysicalTrack,
  chassisCarried,
  chassisWheels,
  type ChassisSpline,
  type ChassisWheel,
  type PhysicalTrack,
} from "./chassis.js";
import { readSlots, type CustomizationSlot } from "./slots.js";
import { child, numbers } from "./read.js";
import { aimingFrom, vector3, type Aiming, type Deployed } from "./aiming.js";

/**
 * What a piece says about the camouflage laid on it.
 *
 * The client multiplies the camouflage's own tiling by the piece's, so the same
 * pattern reads at one size across a hull, a turret and a gun whose textures are
 * packed at wildly different densities: on the IS-7 the gun asks for 0.46 and
 * the turret for 1.3 by 0.64.
 *
 * `exclusionMask` is a texture of its own, named here when the vehicle has one.
 * Most do not, and inventing one out of another map's spare channel is what left
 * a gun barrel unpainted.
 */
export type PieceCamouflage = {
  /** The hand-tuned coefficient, which only the legacy tiling path uses. */
  tiling: number[] | null;
  /**
   * How densely this piece's texture is packed, and how big the occlusion map
   * it is packed against is. Both feed the computed tiling path, which is the
   * one every camouflage that was never hand-tuned for this vehicle takes.
   */
  density: number[] | null;
  aoTextureSize: number[] | null;
  exclusionMask: string | null;
};

export type VehicleScript = {
  /** Where the chassis holds the hull, in metres. */
  hullPosition: number[] | null;
  /** Plate thickness in millimetres, per piece, per plate. */
  armor: Record<string, Record<string, number>>;
  /** Where it carries its gun, and everywhere it can point it. */
  mounts: Aiming;
  /** The same, as it stands once deployed. Null for a vehicle that cannot. */
  siege: Deployed | null;
  /**
   * Which of those plates are screens, per piece.
   *
   * A screen is spaced armour: a shell that beats it has not reached the
   * vehicle, only what stands off it, so its thickness adds to whatever lies
   * behind rather than deciding anything on its own. The client says so by
   * giving the plate a damage factor of zero.
   */
  spaced: Record<string, string[]>;
  /** The chassis's wheels, by the node name the skin turns them through. */
  wheels: Record<string, ChassisWheel>;
  /** How the chassis lays its belt: the pitch, the offsets and the models. */
  spline: ChassisSpline | null;
  /** The wheels the chassis hangs from arms, by skinned bone name. */
  carried: string[];
  /** Which vehicle each piece's armour comes from, by piece, as `nation/code`. */
  shells: Record<string, string>;
  /** Which piece each module draws, by the key the scripts name it with. */
  modules: Record<string, string>;
  /**
   * The CGF prefabs each piece points at, by piece, and the vehicle's own
   * under the empty key.
   *
   * A prefab is where the client keeps everything about a piece that is not its
   * mesh: its muzzle flash, its sounds, and, on the handful of vehicles with a
   * mechanism, the **animation that moves it**. The gun of a vehicle that
   * recalibrates its shells opens six chambers on a five second cycle, and that
   * cycle is a set of keyframed tracks in the prefab and nowhere else: no
   * `.model` in the whole client declares an animation for a vehicle.
   *
   * Collected by shape rather than by path, the way the pieces are: any value
   * naming a `.prefab` counts, wherever the client hangs it. It reaches them
   * under three different parents already (`prefabs/main` on a gun,
   * `prefabs/mechanicEffects` on a vehicle, `slotPrefabs/<hardpoint>` on a
   * hull), and reading the shape means a fourth needs no change here.
   */
  prefabs: Record<string, string[]>;
  /** A belt the chassis simulates as a chain, where it lays none along a path. */
  chain: PhysicalTrack | null;
  /** The belt's own nodes per side, in the order the client chains them. */
  /** How each piece stretches a camouflage, and what it keeps clear of one. */
  camouflage: Record<string, PieceCamouflage>;
  /**
   * Where a piece takes a mark, an emblem or an inscription, by piece.
   *
   * The client places these by projection rather than in the texture: a slot
   * carries a ray to cast along and a size, and whatever surface the ray
   * crosses is what gets marked. So the same emblem sits flat on a sloped plate
   * and wraps a gun barrel without either being drawn into a map.
   */
  slots: Record<string, CustomizationSlot[]>;
  /**
   * The vehicle's 3D styles, and which piece each one replaces.
   *
   * A style is not obliged to restyle a whole vehicle: it lists the pieces it
   * takes over and the rest stay as they are. This is the authority on that,
   * and reading it rather than looking at which files happened to come out of
   * a package is the difference between a style that legitimately keeps the
   * hull and an extraction that lost it.
   *
   * Keyed by style name, then by piece, holding the client path of the model.
   */
  sets: Record<string, Record<string, string>>;
};

/**
 * The plates a piece declares, in millimetres.
 *
 * A plate is usually a bare number, but one that behaves specially carries
 * children instead (`vehicleDamageFactor` on a plate that hurts nothing), and
 * its thickness is still its own value. Anything with no number at all is not a
 * plate: `primaryArmor` lists names, and the odd piece nests a group.
 */
function plates(node: PackedNode | undefined): { armor: Record<string, number>; spaced: string[] } {
  const armor: Record<string, number> = {};
  const spaced: string[] = [];
  if (!node) return { armor, spaced };
  for (const plate of node.children) {
    const value = numbers(plate);
    if (value.length !== 1 || !Number.isFinite(value[0])) continue;
    const side = plate.name;
    armor[side] = value[0];
    const damage = numbers(child(plate, "vehicleDamageFactor"))[0];
    const tags = String(child(plate, "tags")?.value ?? "");
    if (damage === 0 || /\bscreen\b/.test(tags)) spaced.push(side);
  }
  return { armor, spaced };
}

/** `vehicles/russian/R45_IS-7/normal/lod0/Turret_01.model` split in two. */
export function modelPath(node: PackedNode): { content: string; piece: string } | null {
  const raw = child(child(node, "models"), "undamaged")?.value;
  if (typeof raw !== "string") return null;
  const match = /^vehicles\/([^/]+\/[^/]+)\/.*\/([^/]+)\.model$/.exec(raw.trim());
  return match ? { content: match[1], piece: match[2] } : null;
}

/**
 * Walk everything, collecting any node that declares both a model and armour.
 *
 * Going by shape rather than by path means a hull, a chassis, a turret and a
 * gun are all read by the same rule, and a vehicle that nests its pieces
 * unusually is read anyway.
 */
export function collect(node: PackedNode, into: VehicleScript, under?: string): void {
  const model = modelPath(node);
  const piece = model?.piece ?? under;
  {
    const at = String(node.value ?? "").trim();
    if (at.toLowerCase().endsWith(".prefab")) {
      // Under the empty key when nothing above it declares a model, which is
      // where a vehicle hangs the prefab that belongs to the whole tank rather
      // than to one of its pieces: the Strv 107-12's pillbox stance is one.
      // A reader offers those to every piece and lets the curves decide, since
      // a curve naming a node the piece does not have is dropped anyway.
      const known = (into.prefabs[piece ?? ""] ??= []);
      if (!known.includes(at)) known.push(at);
    }
  }
  if (model) {
    // **Which piece each module is**, under the name the scripts give it.
    //
    // A node that declares a model is a module: `_150mm_KwK44_L38` is the E
    // 100's second gun and draws `Gun_06`. That name is the same key the
    // derived specs are tagged with, so a reader who has picked a gun in the
    // configurator can be shown the gun they picked instead of whichever piece
    // happened to sort first.
    into.modules[node.name] ??= model.piece;
    const { armor, spaced } = plates(child(node, "armor"));
    // Several turrets or guns can share one model, the later ones being
    // upgrades. The last wins, which is the fully upgraded vehicle a viewer
    // shows by default.
    if (Object.keys(armor).length > 0) {
      into.armor[model.piece] = armor;
      if (spaced.length > 0) into.spaced[model.piece] = spaced;
      else delete into.spaced[model.piece];
    }
  }
  for (const [name, wheel] of Object.entries(chassisWheels(node))) {
    if (!into.wheels[name]) into.wheels[name] = wheel;
  }
  into.spline ??= chassisSpline(node);
  into.chain ??= chassisPhysicalTrack(node);
  if (into.carried.length === 0) into.carried = chassisCarried(node);
  // A piece's `models` block carries its styles beside its own model, each
  // naming the same piece under `_skins/<style>/`.
  if (model) {
    for (const set of child(child(node, "models"), "sets")?.children ?? []) {
      const at = child(set, "undamaged")?.value;
      if (typeof at !== "string") continue;
      (into.sets[set.name] ??= {})[model.piece] = at.trim();
    }
  }
  if (model) {
    const slots = readSlots(child(node, "customizationSlots"));
    if (slots.length > 0) into.slots[model.piece] = slots;
    const camouflage = child(node, "camouflage");
    const tiling = numbers(child(camouflage, "tiling"));
    const density = numbers(child(camouflage, "density"));
    const aoTextureSize = numbers(child(camouflage, "aoTextureSize"));
    const exclusion = child(camouflage, "exclusionMask")?.value;
    if (tiling.length >= 4 || density.length >= 2 || typeof exclusion === "string") {
      into.camouflage[model.piece] = {
        tiling: tiling.length >= 4 ? tiling.slice(0, 4) : null,
        density: density.length >= 2 ? density.slice(0, 2) : null,
        aoTextureSize: aoTextureSize.length >= 2 ? aoTextureSize.slice(0, 2) : null,
        exclusionMask: typeof exclusion === "string" ? exclusion.trim() : null,
      };
    }
  }
  const position = vector3(child(node, "hullPosition"));
  if (position && !into.hullPosition) into.hullPosition = position;
  // Everything the node says about where the gun can point, which is read the
  // same way and by the same walk but is a subject of its own.
  aimingFrom(node, into.mounts, model?.piece ?? null);
  // **Where this piece's armour lives, which is not always its own vehicle.**
  // A variant ships its own textures and its own visual model and points every
  // hit tester at the tank it was made from: the Ashbringer's four pieces all
  // name `Pl15_60TP_Lewandowskiego`, whose folder is the only one with the
  // Havok shells. Read from the path the client writes, so nothing has to be
  // guessed from a code's prefix.
  const shell = child(child(node, "hitTester"), "collisionModelClient")?.value;
  const path = typeof shell === "string" ? shell.trim() : "";
  const at = /^vehicles\/([^/]+\/[^/]+)\/collision_client\/(.+?)\.model$/i.exec(path);
  if (at) into.shells[at[2]] = at[1];
  for (const c of node.children) collect(c, into, piece);
}

