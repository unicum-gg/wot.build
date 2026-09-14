// Turning what a sweep left in the scratch tree into published files.
//
// Every conversion is per vehicle and per package: a piece needs both its halves
// and the client routinely puts them in different packages, so anything without
// its other half stays on disk until a later package brings it.
import fs from "node:fs";
import path from "node:path";
import { mergeShapes, readCollision } from "../collision.js";
import { readTrackPath } from "../track.js";
import {
  convertCamouflage,
  convertTexture,
  textureRole,
  TextureQuality,
  TextureRole,
} from "../texture.js";
import { texturePath, type PathIndex } from "../material.js";
import { VehicleBuilder } from "../vehicle.js";
import { log, type Settings } from "./settings.js";
import { SKIN_FOLDER, type Accumulated, type Vehicle } from "./sweep.js";
import { readPrefabs } from "../sequence.js";
import type { VehicleScripts } from "../script.js";
import { trackSegment } from "../model.js";
import { decodePacked } from "../packed.js";
import { child, text } from "../read.js";

/**
 * What a camouflage pattern measured, taken as it is converted.
 *
 * **It cannot be read back later.** The scratch tree is emptied as it is
 * consumed, so by the time the run publishes, the client's file is gone: reading
 * it there threw ENOENT into a swallowing catch and every style shipped with no
 * size and four weights, which lays a pattern at the wrong scale and puts the
 * palette's fourth colour over the two thirds of patterns whose alpha is padding.
 * Nothing showed it because the single-vehicle path keeps its sources and has
 * always measured them itself.
 */
export type Measured = Map<string, { size: [number, number]; weights: 3 | 4 }>;

/** Where a run leaves its measurements for the next one. */
const MEASURED_FILE = "patterns.json";

/**
 * What earlier runs measured, so an incremental one is not left guessing.
 *
 * **A run that skips a package measures nothing from it**, and the styles it
 * does resolve name patterns that live in exactly those packages: published
 * from an empty table, they would go out with no size and four weights, which
 * is the failure the note above describes, silently and on a mirror that was
 * already right. A measurement is a property of the client's file rather than
 * of the run that read it, so it is kept beside the mirror like the checksums.
 */
export function readMeasured(out: string): Measured {
  try {
    const held = JSON.parse(
      fs.readFileSync(path.join(out, MEASURED_FILE), "utf8"),
    ) as Record<string, { size: [number, number]; weights: 3 | 4 }>;
    return new Map(Object.entries(held));
  } catch {
    return new Map();
  }
}

/** Record what this run measured, on top of what was already known. */
export function writeMeasured(out: string, measured: Measured): void {
  fs.mkdirSync(out, { recursive: true });
  const sorted = Object.fromEntries([...measured.entries()].sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(out, MEASURED_FILE), `${JSON.stringify(sorted)}\n`);
}

// Shipped beside a vehicle's own textures but never drawn: a baked shadow the
// garage puts under the tank.
const NON_TEXTURE = /HangarShadowMap/i;

/**
 * Whether a converted path is a camouflage's weight map rather than one of its
 * material maps, which share the folder.
 *
 * A pattern is not a picture and is not sampled like one: its channels are
 * weights rather than colours. The same folder holds each camouflage's own
 * gloss-metal, relief and emission maps, and those are ordinary textures. Put
 * through the pattern path they keep the client's channel order, and a coat of
 * paint renders as rust.
 */
export const isPatternPath = (at: string) =>
  /[/\\]Camouflage[/\\]/i.test(at) && textureRole(at) === TextureRole.Other;

function vehicleOut(vehicle: Vehicle, settings: Settings): string {
  const dir = path.join(settings.out, "vehicles", vehicle.nation, vehicle.code);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function convertCollision(work: string, vehicle: Vehicle, into: Accumulated, settings: Settings): void {
  const dir = path.join(work, "vehicles", vehicle.nation, vehicle.code, "collision_client");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".havok")) continue;
    const full = path.join(dir, file);
    try {
      const shapes = readCollision(fs.readFileSync(full));
      if (shapes.length > 0) into.collision[path.basename(file, ".havok")] = mergeShapes(shapes);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} ${path.basename(file, ".havok")} collision: ${(e as Error).message}`);
    }
    settings.consume(full);
  }
}

/**
 * Convert whatever pieces are now complete, and keep the rest.
 *
 * A piece needs both its `.visual_processed` and its `.primitives_processed`,
 * and the client routinely puts them in **different packages** of the same tier.
 * So a file that has not found its other half stays in the scratch tree until a
 * later package brings it, and only converted pairs are dropped.
 */
export function convertPieces(
  work: string,
  vehicle: Vehicle,
  into: Accumulated,
  settings: Settings,
  scripts?: VehicleScripts,
  last = false,
): void {
  const dir = path.join(work, "vehicles", vehicle.nation, vehicle.code, "normal", "lod0");
  if (!fs.existsSync(dir)) return;
  // A 3D style wears its parent's mechanism: the animation is keyed on node
  // names, and a style ships the same skeleton under a folder of its own.
  const parent = vehicle.code.split(`/${SKIN_FOLDER}/`)[0];
  const script = scripts?.scripts.get(`${vehicle.nation}/${parent}`);
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".visual_processed")) continue;
    const name = path.basename(file, ".visual_processed");
    const visual = path.join(dir, file);
    const primitives = path.join(dir, `${name}.primitives_processed`);
    if (!fs.existsSync(primitives)) continue;
    const wanted = [
      ...(script?.prefabs[name] ?? []),
      // And whatever the vehicle names for itself rather than for a piece.
      // Their curves name nodes, so the ones this piece does not have fall away
      // and a stance belonging to the hull does not end up on the gun.
      ...(script?.prefabs[""] ?? []),
    ];
    // **A piece waits for its mechanism, the way it waits for its geometry.**
    // The client splits a vehicle across the packages of its tier, and a prefab
    // is no more guaranteed to travel with the mesh it moves than a
    // `.primitives_processed` is. Converted early, the piece would be written
    // without its animation and never looked at again, so it stays in the
    // scratch tree until a later package brings the file. `last` is the sweep
    // saying there is no later package: whatever is still missing is missing
    // for good, and a piece without its mechanism beats no piece at all.
    if (!last && wanted.some((at) => !fs.existsSync(path.join(work, at)))) continue;
    const clips = readPrefabs(work, wanted);
    // Each piece stands on its own. A hull the reader chokes on used to take
    // the turret and the gun down with it, leaving a vehicle that looks merely
    // incomplete rather than broken, and says nothing about which piece failed.
    try {
      const glb = into.model.add(name, fs.readFileSync(visual), fs.readFileSync(primitives), clips);
      if (glb) fs.writeFileSync(path.join(vehicleOut(vehicle, settings), `${name}.glb`), glb);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} ${name}: ${(e as Error).message}`);
    }
    // Dropped either way: a piece that failed once fails every time, and
    // keeping it would have the sweep retry it against every later package.
    settings.consume(visual);
    settings.consume(primitives);
  }
}

/** The folder a vehicle keeps its belt in, however the client spelled it. */
function trackFolder(work: string, vehicle: Vehicle): string | null {
  const at = path.join(work, "vehicles", vehicle.nation, vehicle.code);
  if (!fs.existsSync(at)) return null;
  const named = fs.readdirSync(at).find((entry) => entry.toLowerCase() === "track");
  return named ? path.join(at, named) : null;
}

/**
 * Where a link's geometry really is, which is not always beside its descriptor.
 *
 * A `.model` is a descriptor and the mesh it names is its `nodelessVisual`. Most
 * of the time that names the file next to it, and reading the folder was as good
 * as reading the descriptor. Sometimes it names another vehicle's: the G.W. E
 * 100 lays the Jagdpanzer E 100's link and the Object 907A the Object 907's, and
 * their own `track/` folders hold two 199-byte descriptors and no geometry at
 * all. Read as a folder those vehicles have no link, so they publish no belt,
 * and the viewer falls back to the flat ribbon the chassis carries: the wheels
 * turn and the track stands still.
 *
 * Resolved against the scratch tree, so it finds the donor only where this run
 * swept it. That is the common case, since a link is shared between vehicles of
 * the same tier and a tier is one package family.
 */
function linkVisual(
  work: string,
  dir: string,
  name: string,
): { at: string } | { borrow: string } | null {
  const own = path.join(dir, `${name}.visual_processed`);
  if (fs.existsSync(own)) return { at: own };
  const descriptor = path.join(dir, `${name}.model`);
  if (!fs.existsSync(descriptor)) return null;
  let named: string | null = null;
  try {
    named = text(child(decodePacked(fs.readFileSync(descriptor)), "nodelessVisual")) || null;
  } catch {
    return null;
  }
  if (!named) return null;
  const at = path.join(work, `${named}.visual_processed`);
  if (fs.existsSync(at)) return { at };
  // Not in this run's scratch tree, which is the common case: a link is shared
  // between vehicles of different tiers and a tier is a package family of its
  // own. Named so the publish can take it from the mirror instead.
  const donor = /^vehicles\/([^/]+\/[^/]+)\//i.exec(named)?.[1];
  return donor ? { borrow: donor } : null;
}

/**
 * Convert a vehicle's track: the path its belt follows and the link laid along
 * it. Both halves are needed, so neither is published without the other.
 *
 * **Driven by the descriptors rather than by whatever geometry is in the
 * folder**, which is how the client reads them and is what lets a vehicle lay a
 * link that lives under another vehicle's name.
 */
export function convertTrack(work: string, vehicle: Vehicle, into: Accumulated, settings: Settings): void {
  const dir = trackFolder(work, vehicle);
  if (!dir) return;
  const files = fs.readdirSync(dir).sort();
  for (const file of files) {
    if (!file.endsWith(".track")) continue;
    const full = path.join(dir, file);
    const parsed = readTrackPath(fs.readFileSync(full));
    if (parsed) into.model.track(path.basename(file, ".track"), parsed.points);
    settings.consume(full);
  }
  // **A link is whatever the folder names, by descriptor or by mesh.** Reading
  // only the meshes misses the vehicles whose link lives under another's name;
  // reading only the descriptors misses the IS-4, whose `Track/` holds a mesh
  // and no descriptor at all. Both halves of one client, so both are taken.
  const links = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".model")) links.add(path.basename(file, ".model"));
    else if (file.endsWith(".visual_processed")) links.add(path.basename(file, ".visual_processed"));
  }
  for (const name of [...links].sort()) {
    const found = linkVisual(work, dir, name);
    if (!found) continue;
    if ("borrow" in found) {
      into.borrowed.add(found.borrow);
      continue;
    }
    const visual = found.at;
    const primitives = visual.replace(/\.visual_processed$/, ".primitives_processed");
    if (!fs.existsSync(primitives)) continue;
    try {
      // **Named after what this vehicle ships, not after the file the geometry
      // came out of.** A belt is often two runs of two different links, and
      // both live here: written under one name the second simply overwrote the
      // first. The chassis names the descriptor, so that name is also what ties
      // the published piece back to the belt that lays it, which matters where
      // the geometry was borrowed and carries another vehicle's name.
      const piece = trackSegment(name);
      const glb = into.model.add(piece, fs.readFileSync(visual), fs.readFileSync(primitives));
      if (glb) fs.writeFileSync(path.join(vehicleOut(vehicle, settings), `${piece}.glb`), glb);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} track link: ${(e as Error).message}`);
    }
    const descriptor = path.join(dir, `${name}.model`);
    if (fs.existsSync(descriptor)) settings.consume(descriptor);
    // Only what this vehicle owns: a borrowed link belongs to the vehicle that
    // ships it, which still has its own belt to lay with it.
    if (path.dirname(visual) === dir) {
      settings.consume(visual);
      settings.consume(primitives);
    }
  }
}

/**
 * Convert every texture the sweep produced.
 *
 * Textures are converted on sight rather than on demand: the material that
 * references one routinely lives in a different package, so waiting for the
 * reference would mean keeping both packages around. `wanted` narrows that to
 * what has actually been referenced, which only makes sense when the run is
 * already narrowed to one vehicle.
 */
export async function convertTextures(
  work: string,
  into: Set<string>,
  measured: Measured,
  settings: Settings,
  wanted?: PathIndex,
): Promise<number> {
  const root = path.join(work, "vehicles");
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".dds")) continue;
      const relative = path.relative(work, full);
      // A high-definition texture is the same texture at twice the side, so it
      // is wanted exactly when the standard one is: match on the name without
      // the suffix, or a single-vehicle run would drop every `_hd` it swept.
      // The match itself is folded, because a material's spelling of a path is
      // not always the file's own.
      const hd = relative.endsWith("_hd.dds");
      const asked = hd ? relative.replace(/_hd\.dds$/, ".dds") : relative;
      if (NON_TEXTURE.test(entry.name)) {
        fs.rmSync(full);
        continue;
      }
      // Not wanted **yet** is not the same as not wanted.
      //
      // `wanted` is what the vehicles read so far name, and this runs after each
      // package. A texture that arrives before the geometry naming it has been
      // read is simply early, so it waits on disk. Deleting it instead lost the
      // hull's own albedo on a single-vehicle run, and the vehicle came out with
      // no paint on it at all: the material named a file that no longer existed,
      // so the whole entry was dropped.
      if (wanted && !wanted.has(asked)) continue;
      if (into.has(relative)) {
        // Already converted by an earlier package. This runs once per package,
        // so without `consume` the file would be deleted on the very next pass
        // and a single-vehicle run would end with no textures on disk at all.
        settings.consume(full);
        continue;
      }
      const target = path.join(settings.out, texturePath(relative));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        if (isPatternPath(relative)) measured.set(relative, await convertCamouflage(full, target));
        else {
          await convertTexture(
            full,
            target,
            hd ? settings.hdTextureSize : settings.textureSize,
            hd ? TextureQuality.High : TextureQuality.Standard,
          );
        }
        into.add(relative);
        count++;
      } catch (e) {
        log(`  ! texture ${relative}: ${(e as Error).message}`);
      }
      settings.consume(full);
    }
  };
  await walk(root);
  return count;
}

/**
 * The stickers, the lettering and the marks of excellence.
 *
 * These live under `gui/` rather than under a vehicle, because the same few
 * hundred serve the whole catalogue, so they are converted once at the end of a
 * run rather than per vehicle. A single-vehicle run skips them: it is the
 * dev path, and `spike/onevehicle.ts` converts exactly the ones it needs.
 */
export async function convertDecals(work: string, into: Set<string>, settings: Settings): Promise<number> {
  const root = path.join(work, "gui");
  if (settings.only || !fs.existsSync(root)) return 0;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".dds")) continue;
      const relative = path.relative(work, full);
      if (into.has(relative)) continue;
      const target = path.join(settings.out, texturePath(relative));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        // Small, and every one of them is a shape cut out of nothing, so the
        // alpha is the whole point and the quality is worth the bytes.
        await convertTexture(full, target, undefined, TextureQuality.High);
        into.add(relative);
        count++;
      } catch (e) {
        log(`  ! decal ${relative}: ${(e as Error).message}`);
      }
    }
  };
  await walk(root);
  return count;
}
