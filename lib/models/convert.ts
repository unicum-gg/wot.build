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
import { texturePath } from "../material.js";
import { VehicleBuilder } from "../vehicle.js";
import { log, type Settings } from "./settings.js";
import type { Accumulated, Vehicle } from "./sweep.js";

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
export function convertPieces(work: string, vehicle: Vehicle, into: Accumulated, settings: Settings): void {
  const dir = path.join(work, "vehicles", vehicle.nation, vehicle.code, "normal", "lod0");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".visual_processed")) continue;
    const name = path.basename(file, ".visual_processed");
    const visual = path.join(dir, file);
    const primitives = path.join(dir, `${name}.primitives_processed`);
    if (!fs.existsSync(primitives)) continue;
    // Each piece stands on its own. A hull the reader chokes on used to take
    // the turret and the gun down with it, leaving a vehicle that looks merely
    // incomplete rather than broken, and says nothing about which piece failed.
    try {
      const glb = into.model.add(name, fs.readFileSync(visual), fs.readFileSync(primitives));
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

/**
 * Convert a vehicle's track: the path its belt follows and the link laid along
 * it. Both halves are needed, so neither is published without the other.
 */
export function convertTrack(work: string, vehicle: Vehicle, into: Accumulated, settings: Settings): void {
  const dir = path.join(work, "vehicles", vehicle.nation, vehicle.code, "track");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, file);
    if (file.endsWith(".track")) {
      const parsed = readTrackPath(fs.readFileSync(full));
      if (parsed) into.model.track(path.basename(file, ".track"), parsed.points);
      settings.consume(full);
      continue;
    }
    if (!file.endsWith(".visual_processed")) continue;
    const name = path.basename(file, ".visual_processed");
    const primitives = path.join(dir, `${name}.primitives_processed`);
    if (!fs.existsSync(primitives)) continue;
    try {
      const glb = into.model.add(VehicleBuilder.TRACK_SEGMENT, fs.readFileSync(full), fs.readFileSync(primitives));
      if (glb) fs.writeFileSync(path.join(vehicleOut(vehicle, settings), `${VehicleBuilder.TRACK_SEGMENT}.glb`), glb);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} track link: ${(e as Error).message}`);
    }
    settings.consume(full);
    settings.consume(primitives);
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
  settings: Settings,
  wanted?: Set<string>,
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
        if (isPatternPath(relative)) await convertCamouflage(full, target);
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
