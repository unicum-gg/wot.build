// Pulling the parts of a client build we read out onto disk.
//
// A package's name does not describe its contents, so what a file **is** is
// decided by its path and by nothing else. The globs below are that decision.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SparseArchive, type Block } from "../archive.js";
import { CUSTOMIZATION_GLOBS, VEHICLE_SCRIPTS_GLOB } from "../script.js";
import { TRACK_GLOB } from "../track.js";
import { VehicleBuilder } from "../vehicle.js";
import type { CollisionPart } from "../collision.js";
import type { Settings } from "./settings.js";

export type Vehicle = { nation: string; code: string };
export type Accumulated = {
  collision: Record<string, CollisionPart>;
  model: VehicleBuilder;
};
/** Every vehicle a run has read so far, keyed `nation/code`. */
export type Catalogue = Map<string, Accumulated>;

export function accumulate(catalogue: Catalogue, vehicle: Vehicle): Accumulated {
  const key = `${vehicle.nation}/${vehicle.code}`;
  let entry = catalogue.get(key);
  if (!entry) {
    entry = { collision: {}, model: new VehicleBuilder() };
    catalogue.set(key, entry);
  }
  return entry;
}

// Vehicles ship in the per-tier packages, but the textures a nation shares
// between its vehicles (every track, and the maps a whole nation draws with) sit
// in the shared packages instead, so both have to be walked or a material would
// reference a texture that was never published. The `_sandbox` ones are not a
// test mode despite the name: a fifth of all vehicles have their track textures
// there and nowhere else.
export const SHARED_PACKAGE = /^res\/packages\/shared_content(?:_sandbox)?(?:-part\d+)?\.pkg$/;
// The client ships its textures twice, and only its textures: `hdcontent` holds
// no geometry at all, just a `*_hd.dds` beside each `*.dds` at twice the side.
// Both are published so a viewer can offer the choice, and the geometry, which
// is the same either way, is never duplicated.
export const HD_SHARED_PACKAGE = /^res\/packages\/shared_content(?:_sandbox)?_hd(?:-part\d+)?\.pkg$/;
// The scripts, read for the one number the meshes do not carry: how high a
// chassis holds its hull.
export const SCRIPT_PACKAGE = /^res\/packages\/scripts\.pkg$/;

// What is taken out of a package. The visual mesh is read at its finest level of
// detail, and textures sit either beside a vehicle or in a folder it shares with
// the rest of its nation, which the same depth covers. Everything deeper
// (alternative liveries, wrecks, coarser levels of detail) is left behind.
const COLLISION_GLOB = "vehicles/*/*/collision_client/*.havok";
const VISUAL_GLOBS = ["vehicles/*/*/normal/lod0/*", "vehicles/*/*/*.dds", TRACK_GLOB];
const SHARED_GLOBS = ["vehicles/*/*/*.dds"];

// A vehicle's alternative skins, one folder deeper, each a full set of pieces
// with textures of its own. Left out by default: 237 vehicles declare 330 of
// them between them and taking the lot would swell the mirror for a feature
// nothing reads yet. `--skins` pulls them, which is what looking at one
// vehicle's styles needs.
const SKIN_GLOBS = ["vehicles/*/*/_skins/*/normal/lod0/*", "vehicles/*/*/_skins/*/*.dds"];

// What a 2D style puts on a vehicle that is not paint: the marks of excellence
// and the stickers and lettering. These live under `gui/` rather than under a
// vehicle, because the same few hundred serve the whole catalogue, and they sit
// in the `gui-part*` packages rather than in any vehicle package.
const DECAL_GLOBS = ["gui/maps/vehicles/decals/*", "gui/maps/vehicles/decals/*/*", "gui/maps/vehicles/decals/*/*/*"];

/**
 * Every package a part holds, keyed by name.
 *
 * **All of them**, because a package's name does not describe its contents. The
 * IS-7's Hardline hull, geometry and textures both, ships inside `particles.pkg`
 * and `particles_hd.pkg`; the same style's chassis, gun and turret are spread
 * across the three `vehicles_level_10` parts. Wargaming fills packages to size,
 * not by subject, so an allowlist keyed on the name reads whatever happens to be
 * named plausibly and silently loses the rest. What a file **is** is decided by
 * its path, and the globs in `sweep` already do that.
 *
 * The cost is reading the whole client rather than the half of it that sounds
 * relevant. `--package` narrows it when a run already knows where to look.
 */
export function packages(archive: SparseArchive, settings: Settings): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const block of archive.index().values()) {
    if (!/packages\/.+\.pkg$/.test(block.name)) continue;
    if (settings.packages && !settings.packages.some((p) => block.name.includes(p))) continue;
    out.set(block.name, block);
  }
  return out;
}

/** Unpack the parts of one package we read, into a scratch tree. */
export async function sweep(
  archive: SparseArchive,
  block: Block,
  work: string,
  settings: Settings,
): Promise<void> {
  const pkgDir = path.join(archive.dir, "pkg");
  fs.rmSync(pkgDir, { recursive: true, force: true });
  const pkg = await archive.extract(block, pkgDir);
  // The same patterns for every package, because the name says nothing about
  // what is inside: a package called `particles` holds a vehicle's hull. Asking
  // 7z for a few extra patterns costs nothing next to reading the block, and it
  // is what makes the sweep depend on paths alone.
  const globs = settings.collisionOnly
    ? [COLLISION_GLOB]
    : [
        COLLISION_GLOB,
        ...VISUAL_GLOBS,
        ...SHARED_GLOBS,
        VEHICLE_SCRIPTS_GLOB,
        ...CUSTOMIZATION_GLOBS,
        ...DECAL_GLOBS,
        ...(settings.withSkins ? SKIN_GLOBS : []),
      ];
  execFileSync("7z", ["x", pkg, ...globs.map((g) => `-i!${g}`), `-o${work}`, "-y"], { stdio: "ignore" });
  fs.rmSync(pkgDir, { recursive: true, force: true });
}

/** The vehicle folders a sweep produced, in a stable order. */
export function swept(work: string): Vehicle[] {
  const root = path.join(work, "vehicles");
  if (!fs.existsSync(root)) return [];
  const out: Vehicle[] = [];
  for (const nation of fs.readdirSync(root).sort()) {
    const nationDir = path.join(root, nation);
    if (!fs.statSync(nationDir).isDirectory()) continue;
    for (const code of fs.readdirSync(nationDir).sort()) {
      if (!fs.statSync(path.join(nationDir, code)).isDirectory()) continue;
      out.push({ nation, code });
    }
  }
  return out;
}
