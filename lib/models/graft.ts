// Completing one manifest from another.
//
// A folder of geometry is not always a whole tank. A 3D style ships only the
// pieces it restyles, a vehicle can keep one of its pieces in a sibling's
// folder, and in both cases what is published is a manifest with a hole in it.
// The repair is the same either way and is almost entirely one problem: a mesh
// names its material by POSITION in its own manifest's list, so a piece moved
// between two manifests keeps a number that now points at something else.
import fs from "node:fs";
import path from "node:path";
import type { VehicleScripts } from "../script.js";
import type { VehicleModel } from "../model.js";
import { log, type Settings } from "./settings.js";

/**
 * Drop the materials no piece draws with, renumbering the ones that stay.
 *
 * **Grafting appends a whole list to keep the arithmetic simple**, and a
 * manifest that is grafted into on run after run would carry the donor's list
 * again every time: a vehicle whose pieces arrive from two packages would grow
 * its material list at every incremental build until it is mostly dead weight.
 * A material is reachable only through a mesh, so what nothing names can go.
 */
export function compact(model: VehicleModel): void {
  const used = new Map<number, number>();
  for (const piece of Object.values(model.pieces)) {
    for (const mesh of piece.meshes) {
      for (const index of mesh.materials) {
        if (!used.has(index)) used.set(index, used.size);
      }
    }
  }
  if (used.size === model.materials.length) return;
  const kept = [...used.keys()].map((index) => model.materials[index]);
  for (const piece of Object.values(model.pieces)) {
    for (const mesh of piece.meshes) {
      mesh.materials = mesh.materials.map((index) => used.get(index) ?? 0);
    }
  }
  model.materials = kept;
}

/** A manifest already on the mirror, or null where there is none to read. */
export function readManifest(at: string): VehicleModel | null {
  try {
    return JSON.parse(fs.readFileSync(at, "utf8")) as VehicleModel;
  } catch {
    return null;
  }
}

/**
 * Copy pieces from another manifest into this one.
 *
 * **The material index is the whole difficulty.** A mesh names its material by
 * position in its own manifest's list, so a piece moved between two manifests
 * keeps a number that now points at something else: a track drawn with a gun's
 * paint, a hull with a turret's. The donor's list is appended and the grafted
 * indices are shifted by where it starts.
 *
 * `from` is how the copied files are reached from the manifest being written,
 * empty where both sit in the same folder.
 */
export function graft(model: VehicleModel, donor: VehicleModel, pieces: string[], from = ""): void {
  if (pieces.length === 0) return;
  const offset = model.materials.length;
  model.materials = [...model.materials, ...donor.materials];
  for (const name of pieces) {
    const piece = structuredClone(donor.pieces[name]);
    model.pieces[name] = {
      ...piece,
      glb: from ? `${from}/${piece.glb}` : piece.glb,
      meshes: piece.meshes.map((mesh) => ({
        ...mesh,
        materials: mesh.materials.map((index) => index + offset),
      })),
    };
  }
}

// **A piece a vehicle keeps in another vehicle's folder.**
//
// The conversion walks folders: it reads `vehicles/<nation>/<code>/normal/
// lod0` and converts whatever is in it. A vehicle that declares one of its
// pieces in a SIBLING's folder is therefore never offered that piece at all,
// and comes out of the run with a hole in it rather than with an error. Two
// do it: the 111 Vz. 51 ships its hull, turret and gun under its own name
// and points its chassis at the 111 1-2-3's folder, and the 50TP Prototyp
// (Resilient) ships a hull and takes the other three from the plain 50TP
// prototyp. Published as they arrived, the first had no running gear and the
// second had no gun either.
//
// It is the style graft seen from one folder over: a manifest completed from
// another by pointing the `glb` across and renumbering the materials, which
// is the one thing a copied piece cannot keep. The wheels come with it for a
// reason of their own, below.
//
// Walked over every script rather than over this run's vehicles, unlike the
// belt and the style passes that follow it: a vehicle nobody rebuilt today is
// still one the mirror publishes with a hole, and grafting a piece a manifest
// already has is a no-op, so a run that changes nothing writes nothing.
export function borrowPieces(scripts: VehicleScripts, settings: Settings): void {
  for (const [key, script] of scripts.scripts) {
    const elsewhere = Object.entries(script.drawn).filter(([, from]) => from !== key);
    if (elsewhere.length === 0) continue;
    const at = path.join(settings.out, "vehicles", key, "model.json");
    const model = readManifest(at);
    if (!model) continue;
    const wanted = elsewhere.filter(([piece]) => !model.pieces[piece]);
    if (wanted.length === 0) continue;
    const took: string[] = [];
    for (const from of new Set(wanted.map(([, folder]) => folder))) {
      const donor = readManifest(path.join(settings.out, "vehicles", from, "model.json"));
      if (!donor) continue;
      const pieces = wanted
        .filter(([piece, folder]) => folder === from && donor.pieces[piece])
        .map(([piece]) => piece);
      if (pieces.length === 0) continue;
      graft(model, donor, pieces, path.posix.relative(`vehicles/${key}`, `vehicles/${from}`));
      // **The running gear is read off the mesh, not off the script.** A
      // chassis declares its wheels by bone name and the converter resolves
      // them against the converted piece, so a vehicle that never converted a
      // chassis has an empty wheel list however much its script says. Carried
      // across with the piece, like a style does, or the belt is laid from
      // nothing and the wheels never turn.
      const held = model as unknown as Record<string, unknown[]>;
      const under = donor as unknown as Record<string, unknown[]>;
      for (const field of ["wheels", "levers", "carried"] as const) {
        if (!held[field]?.length && under[field]?.length) held[field] = under[field];
      }
      took.push(...pieces);
    }
    if (took.length === 0) continue;
    compact(model);
    fs.writeFileSync(at, JSON.stringify(model));
    log(`  ${key} took ${took.sort().join(", ")} from the folder its script names`);
  }
}
