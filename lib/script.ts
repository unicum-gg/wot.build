// Reading what a vehicle's script says about its pieces.
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
//
// The scripts ship as packed XML in a package of their own, small enough that
// reading it costs nothing next to the geometry packages.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, isPacked, type PackedNode } from "./packed.js";

/** Where the vehicle scripts sit inside their package. */
export const VEHICLE_SCRIPTS_GLOB = "scripts/item_defs/vehicles/*/*.xml";

/**
 * Where the customization data sits: the paints, the camouflages and the 3D
 * styles, with their palettes, their scales and the names players see.
 *
 * A vehicle's own script names its styles by folder (`R45_IS-7_BPXVIII_3Dst`);
 * only this says that folder is called Hardline, and only this says what a
 * camouflage is made of. Taken at two depths because the client keeps some of
 * it in one file and some in a folder per kind.
 */
export const CUSTOMIZATION_GLOBS = [
  "scripts/item_defs/customization/*.xml",
  "scripts/item_defs/customization/*/*.xml",
];

/** What a chassis says about one of its wheels, which no mesh says. */
export type ChassisWheel = {
  /** The node the client turns, as the tree names it: `W_L0`, `WD_R1`. */
  name: string;
  /** How big the wheel is, which is what decides how fast it turns. */
  radius: number;
  /**
   * The circle the track wraps it on, which is not its rim.
   *
   * On a drive sprocket the track sits down in the tooth roots, well inside the
   * tips: the IS-7's is a 432 mm wheel the track wraps at 381. On an idler it
   * stands off instead, by the link's own thickness. Only the road wheels have
   * the two the same.
   */
  wrap: number;
};

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
  /**
   * Where the turret sits on the hull, and where each turret carries its gun.
   *
   * A piece is modelled around its own origin, so a viewer has to be told where
   * each hangs off the one before. The meshes carry the same points as named
   * hardpoints, but only where the piece has a visual model at all, and a few
   * vehicles ship none for their hull.
   */
  mounts: {
    turret: number[] | null;
    guns: Record<string, number[]>;
    /**
     * How far each gun lets its turret turn, in degrees either side of straight
     * ahead. A vehicle with no limit turns all the way round; a casemate is a
     * casemate precisely because it cannot.
     */
    yaw: Record<string, number[]>;
    /**
     * How far each gun elevates and depresses, in degrees. The client counts
     * downwards, so its `maxPitch` is the depression a player talks about.
     */
    pitch: Record<string, number[]>;
  };
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

function child(node: PackedNode | undefined, name: string): PackedNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function numbers(node: PackedNode | undefined): number[] {
  if (!node) return [];
  if (Array.isArray(node.value)) return node.value.map(Number);
  if (typeof node.value === "number") return [node.value];
  if (typeof node.value === "string") {
    return node.value.trim().split(/\s+/).map(Number);
  }
  return [];
}

/**
 * A point from the script, flipped into the space the geometry is published in.
 *
 * The client is left-handed and glTF is not, so every piece is mirrored across
 * its centreline on the way out. A mount point that skipped that flip would put
 * a turret slightly off to the wrong side of a hull that had taken it.
 */
function vector3(value: PackedNode | undefined): number[] | null {
  const raw = numbers(value);
  if (!(raw.length >= 3 && raw.every((n) => !Number.isNaN(n)))) return null;
  return [-raw[0], raw[1], raw[2]];
}

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

/**
 * The wheels a chassis declares.
 *
 * `wheels` names the drive wheels and idlers one at a time and the road wheels
 * as a run: a `group` with `template` `W_L`, `startIndex` 0 and `count` 7 means
 * `W_L0` through `W_L6`, all of one radius. Where the track wraps them is kept
 * somewhere else entirely, in the physical track's `wheelGroups`, and falls back
 * to the wheel itself where the vehicle gives none.
 */
function chassisWheels(node: PackedNode): Record<string, ChassisWheel> {
  const declared = child(node, "wheels");
  if (!declared) return {};
  const radius: Record<string, number> = {};
  for (const wheel of declared.children) {
    const size = numbers(child(wheel, "radius"))[0];
    if (!Number.isFinite(size) || size <= 0) continue;
    if (wheel.name === "wheel") {
      const name = String(child(wheel, "name")?.value ?? "").trim();
      if (name) radius[name] = size;
      continue;
    }
    if (wheel.name !== "group") continue;
    const template = String(child(wheel, "template")?.value ?? "").trim();
    const start = numbers(child(wheel, "startIndex"))[0] || 0;
    const count = numbers(child(wheel, "count"))[0] || 0;
    if (!template) continue;
    for (let i = 0; i < count; i++) radius[`${template}${start + i}`] = size;
  }

  const wrap: Record<string, number> = {};
  const groups = (from: PackedNode): void => {
    if (from.name === "wheelGroup") {
      const size = numbers(child(from, "groupRadius"))[0];
      if (Number.isFinite(size) && size > 0) {
        for (const named of from.children.filter((c) => c.name === "wheelName")) {
          const name = String(named.value ?? "").trim();
          if (name && wrap[name] === undefined) wrap[name] = size;
        }
      }
      return;
    }
    for (const c of from.children) groups(c);
  };
  const tracks = child(node, "tracks");
  if (tracks) groups(tracks);

  return Object.fromEntries(
    Object.entries(radius).map(([name, size]) => [name, { name, radius: size, wrap: wrap[name] ?? size }]),
  );
}

/**
 * Three angles as the client wrote them.
 *
 * **Kept unflipped on purpose.** A slot's rotation is not read as a rotation of
 * the mirrored vehicle: the axes it names are taken out of it first and each is
 * mirrored on its own. Pushing the angles through the point reader, which
 * negates X, turned a decal the wrong way and inside out.
 */
function plain3(value: PackedNode | undefined): number[] | null {
  const raw = numbers(value);
  return raw.length >= 3 && raw.every((n) => !Number.isNaN(n)) ? raw.slice(0, 3) : null;
}

function readSlots(node: PackedNode | undefined): CustomizationSlot[] {
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

/** `vehicles/russian/R45_IS-7/normal/lod0/Turret_01.model` split in two. */
function modelPath(node: PackedNode): { content: string; piece: string } | null {
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
function collect(node: PackedNode, into: VehicleScript): void {
  const model = modelPath(node);
  if (model) {
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
  // A hull names one turret position and each turret names where its gun goes.
  const turret = child(node, "turretPositions")?.children.map(vector3).find(Boolean);
  if (turret && !into.mounts.turret) into.mounts.turret = turret;
  const gun = vector3(child(node, "gunPosition"));
  if (gun && model) into.mounts.guns[model.piece] = gun;
  if (model) {
    const yaw = numbers(child(node, "turretYawLimits"));
    if (yaw.length >= 2) into.mounts.yaw[model.piece] = [yaw[0], yaw[1]];
    // The limits come as pairs of (turret angle, limit) because a gun can be
    // stopped by its own hull: only the widest of them matters to a viewer that
    // is not simulating where the turret is pointed.
    const limits = child(node, "pitchLimits");
    const every = (name: string) => numbers(child(limits, name)).filter((_, i) => i % 2 === 1);
    const down = every("maxPitch");
    const up = every("minPitch");
    if (down.length > 0 || up.length > 0) {
      into.mounts.pitch[model.piece] = [Math.min(...up, 0), Math.max(...down, 0)];
    }
  }
  for (const c of node.children) collect(c, into);
}

/** The content path a script's pieces are published under, if it names one. */
function contentPath(node: PackedNode): string | null {
  const model = modelPath(node);
  if (model) return model.content;
  for (const c of node.children) {
    const found = contentPath(c);
    if (found) return found;
  }
  return null;
}

/**
 * Every vehicle script under `dir`, keyed by the content path it publishes to.
 *
 * Several scripts share one content path: a vehicle, its clone for a seasonal
 * mode, its training dummy. They describe the same geometry with different
 * loadouts, and a mode's clone often carries only the pieces that mode uses, so
 * they are merged, with the vehicle's own script winning any disagreement. It is
 * recognised by its filename matching the folder its content sits in, which is
 * the only thing that separates it from its clones.
 *
 * A script naming no model at all is skipped: without one there is no way to say
 * which geometry it describes.
 */
/** What a customization filter needs to know about a vehicle. */
export type VehicleIdentity = {
  /** The name the scripts use, `ussr`, which is not the content folder's. */
  nation: string;
  /** `ussr:R45_IS-7`, the way a filter names one vehicle. */
  key: string;
  level: number;
  tags: string[];
  /** How much the vehicle stretches a camouflage, from its own script. */
  density: [number, number];
};

/**
 * A vehicle's nation, tier and tags, out of its nation's own index.
 *
 * The scripts and the content name a nation differently, `ussr` against
 * `russian`, and nothing in a content path says which. Rather than carry a
 * table of the eleven pairs, this looks the code up in every nation's index and
 * takes the nation that has it, which is right by construction.
 */
export function readVehicleIdentity(dir: string, code: string): VehicleIdentity | null {
  if (!fs.existsSync(dir)) return null;
  for (const nation of fs.readdirSync(dir)) {
    const list = path.join(dir, nation, "list.xml");
    if (!fs.existsSync(list)) continue;
    const entry = child(decodePacked(fs.readFileSync(list)), code);
    if (!entry) continue;
    const own = path.join(dir, nation, `${code}.xml`);
    const camouflage = fs.existsSync(own) ? child(child(decodePacked(fs.readFileSync(own)), "camouflage"), "density") : undefined;
    const [dx = 1, dy = 1] = numbers(camouflage);
    return {
      nation,
      key: `${nation}:${code}`,
      level: Number(child(entry, "level")?.value ?? 0),
      tags: String(child(entry, "tags")?.value ?? "").trim().split(/\s+/).filter(Boolean),
      density: [dx || 1, dy || 1],
    };
  }
  return null;
}

export function readVehicleScripts(dir: string): Map<string, VehicleScript> {
  const out = new Map<string, VehicleScript>();
  // Which pieces came from the vehicle's own script rather than from a clone.
  const canonical = new Map<string, Set<string>>();
  if (!fs.existsSync(dir)) return out;
  for (const nation of fs.readdirSync(dir)) {
    const nationDir = path.join(dir, nation);
    if (!fs.statSync(nationDir).isDirectory()) continue;
    for (const file of fs.readdirSync(nationDir)) {
      if (!file.endsWith(".xml")) continue;
      const buf = fs.readFileSync(path.join(nationDir, file));
      if (!isPacked(buf)) continue;
      try {
        const root = decodePacked(buf);
        const key = contentPath(root);
        if (!key) continue;
        const read: VehicleScript = { hullPosition: null, armor: {}, spaced: {}, wheels: {}, sets: {}, slots: {}, camouflage: {}, mounts: { turret: null, guns: {}, yaw: {}, pitch: {} } };
        collect(root, read);
        const own = path.basename(file, ".xml") === key.split("/")[1];

        if (!out.has(key)) {
          out.set(key, { hullPosition: null, armor: {}, spaced: {}, wheels: {}, sets: {}, slots: {}, camouflage: {}, mounts: { turret: null, guns: {}, yaw: {}, pitch: {} } });
          canonical.set(key, new Set());
        }
        const target = out.get(key)!;
        const fromOwn = canonical.get(key)!;
        for (const [piece, armor] of Object.entries(read.armor)) {
          if (target.armor[piece] && !own) continue;
          if (target.armor[piece] && fromOwn.has(piece)) continue;
          target.armor[piece] = armor;
          if (read.spaced[piece]) target.spaced[piece] = read.spaced[piece];
          else delete target.spaced[piece];
          if (own) fromOwn.add(piece);
        }
        for (const [name, wheel] of Object.entries(read.wheels)) {
          if (!target.wheels[name] || own) target.wheels[name] = wheel;
        }
        for (const [piece, slots] of Object.entries(read.slots)) {
          if (!target.slots[piece] || own) target.slots[piece] = slots;
        }
        for (const [piece, camouflage] of Object.entries(read.camouflage)) {
          if (!target.camouflage[piece] || own) target.camouflage[piece] = camouflage;
        }
        for (const [style, pieces] of Object.entries(read.sets)) {
          target.sets[style] = { ...(target.sets[style] ?? {}), ...pieces };
        }
        if (read.hullPosition && (!target.hullPosition || own)) target.hullPosition = read.hullPosition;
        if (read.mounts.turret && (!target.mounts.turret || own)) target.mounts.turret = read.mounts.turret;
        for (const key of ["guns", "yaw", "pitch"] as const) {
          for (const [piece, value] of Object.entries(read.mounts[key])) {
            if (!target.mounts[key][piece] || own) target.mounts[key][piece] = value;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return out;
}
