// Every vehicle script in the client, read and merged onto the geometry.
//
// A folder of meshes is not a vehicle: far more codes exist than folders, since
// an event reskin, a clan reissue, a mode's clone and a vehicle renamed since
// its folder was made all draw from one set. They describe the same geometry
// with different loadouts, so their scripts are merged onto the folder they
// publish to, and the vehicle whose own name matches that folder wins any
// disagreement.
//
// A vehicle that can plant itself is the one exception, because it ships a
// second definition of itself rather than a variant of itself. That one is kept
// aside as the state it describes, never merged over the vehicle it belongs to.
//
// The scripts ship as packed XML in a package of their own, small enough that
// reading it costs nothing next to the geometry packages.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, isPacked, type PackedNode } from "./packed.js";
import { deployedFrom, noAiming } from "./aiming.js";
import { collect, modelPath, type VehicleScript } from "./pieces.js";

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

/** What the vehicle scripts say, and who says it. */
export type VehicleScripts = {
  /** The merged script data, keyed by the content path it publishes to. */
  scripts: Map<string, VehicleScript>;
  /**
   * Every vehicle code drawing from each content path, keyed the same way.
   *
   * **A vehicle is not the same thing as a folder of geometry.** Far more codes
   * exist than folders: an event reskin, a clan reissue, a mode's clone and a
   * vehicle renamed since its folder was made all draw from one set of meshes.
   * `R43_T-70` draws from `R43_T70`, `R71_IS_2B` from `R71_IS_2_Berlin`, and a
   * quarter of the catalogue is codes like these.
   *
   * Merging them is right, since the geometry really is one; forgetting them is
   * not. Only the code that happened to name the folder was ever published, so
   * every other one looked to a consumer like a vehicle the mirror does not
   * carry, and 236 of 1232 vehicles fell back to a picture with their meshes
   * already sitting on disk.
   */
  drawnBy: Map<string, string[]>;
};

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
/** What the client calls a vehicle's deployed definition, by file name. */
const DEPLOYED = "_siege_mode";

export function readVehicleScripts(dir: string): VehicleScripts {
  const out = new Map<string, VehicleScript>();
  const drawnBy = new Map<string, string[]>();
  // Which pieces came from the vehicle's own script rather than from a clone.
  const canonical = new Map<string, Set<string>>();
  if (!fs.existsSync(dir)) return { scripts: out, drawnBy };
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
        const read: VehicleScript = {
          hullPosition: null,
          armor: {},
          spaced: {},
          wheels: {},
          spline: null,
          chain: null,
          carried: [],
          shells: {},
          modules: {},
          prefabs: {},
          sets: {},
          slots: {},
          camouflage: {},
          mounts: noAiming(),
          siege: null,
        };
        collect(root, read);
        const code = path.basename(file, ".xml");
        const own = code === key.split("/")[1];
        // A deployed definition is the same tank standing differently, not
        // another tank: it draws the same geometry and would otherwise be
        // published as a vehicle of its own and merged over the one it belongs
        // to. Kept aside as the state it describes.
        const deployed = code.endsWith(DEPLOYED);
        // Recorded whether or not this script contributes a single piece: what
        // makes a code worth publishing is that it draws from this geometry,
        // not that it had something to add to it.
        if (!deployed) {
          const codes = drawnBy.get(key);
          if (codes) codes.push(code);
          else drawnBy.set(key, [code]);
        }

        if (!out.has(key)) {
          out.set(key, {
          hullPosition: null,
          armor: {},
          spaced: {},
          wheels: {},
          spline: null,
          chain: null,
          carried: [],
          shells: {},
          modules: {},
          prefabs: {},
          sets: {},
          slots: {},
          camouflage: {},
          mounts: noAiming(),
          siege: null,
        });
          canonical.set(key, new Set());
        }
        const target = out.get(key)!;
        if (deployed) {
          target.siege = deployedFrom(read.mounts);
          continue;
        }
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
        // The belt is one per chassis, so it is taken whole rather than merged
        // key by key: a clone that declares its own spline replaces the one a
        // sibling contributed, and a clone that declares none leaves it alone.
        if (read.spline && (!target.spline || own)) target.spline = read.spline;
        if (read.chain && (!target.chain || own)) target.chain = read.chain;
        if (read.carried.length > 0 && (target.carried.length === 0 || own)) {
          target.carried = read.carried;
        }
        for (const [piece, from] of Object.entries(read.shells)) {
          if (!target.shells[piece] || own) target.shells[piece] = from;
        }
        for (const [key, piece] of Object.entries(read.modules)) {
          if (!target.modules[key] || own) target.modules[key] = piece;
        }
        // Unioned rather than replaced: two vehicles sharing a hull can each
        // hang their own mechanism off it, and a piece that draws for both
        // should offer both animations rather than whichever was read last.
        for (const [piece, paths] of Object.entries(read.prefabs)) {
          const known = (target.prefabs[piece] ??= []);
          for (const at of paths) if (!known.includes(at)) known.push(at);
        }
        if (read.hullPosition && (!target.hullPosition || own)) target.hullPosition = read.hullPosition;
        if (read.mounts.turret && (!target.mounts.turret || own)) target.mounts.turret = read.mounts.turret;
        if (read.mounts.hullPitch && (!target.mounts.hullPitch || own)) {
          target.mounts.hullPitch = read.mounts.hullPitch;
        }
        for (const key of ["turretPitch", "gunJoint"] as const) {
          if (read.mounts[key] !== null && (target.mounts[key] === null || own)) {
            target.mounts[key] = read.mounts[key];
          }
        }
        for (const key of ["guns", "yaw", "pitch", "sweep"] as const) {
          for (const [piece, value] of Object.entries(read.mounts[key])) {
            if (!target.mounts[key][piece] || own) target.mounts[key][piece] = value;
          }
        }
      } catch {
        continue;
      }
    }
  }
  for (const codes of drawnBy.values()) codes.sort();
  return { scripts: out, drawnBy };
}
