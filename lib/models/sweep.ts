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
import { SkinScope, type Settings } from "./settings.js";

export type Vehicle = { nation: string; code: string };
export type Accumulated = {
  collision: Record<string, CollisionPart>;
  model: VehicleBuilder;
  /**
   * Vehicles this one's track descriptors point at for their geometry, as
   * `nation/code`.
   *
   * A link is shared far more often than a tier is: the E 75 lays the Tiger
   * II's, the T78 the M41's, the G.W. E 100 the Jagdpanzer E 100's. Where the
   * donor sits in another package family this run may not hold its mesh at all,
   * so the reference is carried through to the publish, which reads the mirror
   * rather than the scratch tree and finds it there.
   */
  borrowed: Set<string>;
};
/** Every vehicle a run has read so far, keyed `nation/code`. */
export type Catalogue = Map<string, Accumulated>;

export function accumulate(catalogue: Catalogue, vehicle: Vehicle): Accumulated {
  const key = `${vehicle.nation}/${vehicle.code}`;
  let entry = catalogue.get(key);
  if (!entry) {
    entry = { collision: {}, model: new VehicleBuilder(), borrowed: new Set() };
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
// The CGF prefabs, which are where a mechanism's animation lives. They are JSON
// and there are a few hundred of them, so the whole tree is taken rather than
// the handful a run happens to reference: a prefab points at other prefabs, and
// resolving that from a glob would mean sweeping twice.
const PREFAB_GLOBS = [
  "content/CGFPrefabs/*.prefab",
  "content/CGFPrefabs/*/*.prefab",
  "content/CGFPrefabs/*/*/*.prefab",
  "content/CGFPrefabs/*/*/*/*.prefab",
  "content/CGFPrefabs/*/*/*/*/*.prefab",
];
const VISUAL_GLOBS = ["vehicles/*/*/normal/lod0/*", "vehicles/*/*/*.dds", TRACK_GLOB];
const SHARED_GLOBS = ["vehicles/*/*/*.dds"];

// A vehicle's alternative skins, one folder deeper, each a full set of pieces
// with textures of its own. 237 vehicles declare 330 of them between them, so
// taking the lot swells the mirror for a wardrobe that offers them one at a
// time, which is what `--skins` is for.
//
// **What is taken by default is the handful a vehicle cannot take off.** Those
// are not alternatives: 32 of the 40 vehicles wearing one ship no geometry of
// their own, so the mirror indexes them onto the tank underneath and, without
// the set, every one of them is drawn as that tank instead of as itself.
/** The folder a vehicle keeps its 3D styles in, one set of pieces per name. */
export const SKIN_FOLDER = "_skins";

/**
 * What to take out of the `_skins` tree, given which sets are wanted.
 *
 * Named one by one rather than filtered afterwards, because the filtering that
 * matters happens inside 7z: what is not matched is never written, and the
 * scratch tree is the thing a run is bounded by.
 */
function skinGlobs(settings: Settings, wanted: ReadonlySet<string>): string[] {
  const sets = settings.skins === SkinScope.All ? ["*"] : [...wanted].sort();
  return sets.flatMap((set) => [
    `vehicles/*/*/${SKIN_FOLDER}/${set}/normal/lod0/*`,
    `vehicles/*/*/${SKIN_FOLDER}/${set}/*.dds`,
  ]);
}

// What a 2D style puts on a vehicle that is not paint: the marks of excellence
// and the stickers and lettering. These live under `gui/` rather than under a
// vehicle, because the same few hundred serve the whole catalogue, and they sit
// in the `gui-part*` packages rather than in any vehicle package.
const DECAL_GLOBS = ["gui/maps/vehicles/decals/*", "gui/maps/vehicles/decals/*/*", "gui/maps/vehicles/decals/*/*/*"];

/**
 * The packages a narrowed run sweeps whatever it was asked for.
 *
 * **A package's name does not describe its contents**, which is the note on
 * `packages` below and the reason this exists: the AMX 50 B's Improved
 * Mechanism keeps its equipment and damage textures in `particles.pkg`, and the
 * IS-7's Hardline keeps a whole hull there. Asked for `vehicles_level_10`
 * alone, that style was published with a material holding no colour at all, and
 * the tank was drawn with white patches across its turret and hull.
 *
 * So `--package` narrows the tiers, which is what a person means by it, and
 * these are swept regardless: the shared and sandbox content, the catch-alls,
 * the interface, and the scripts every vehicle needs.
 *
 * **The maps are what is left out, and they are most of the client.** A
 * hundred-odd packages named for the arena they draw, each a hundred megabytes,
 * holding no vehicle. Their names all begin with the arena's number, which is a
 * convention Wargaming has kept for as long as this mirror has read them; the
 * sound and the shaders go with them for the same reason.
 */
const ALWAYS =
  /packages\/(?!\d+_|audioww|shaders|vehicles_level_)[^/]+\.pkg$/;

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
    // **The scripts are never optional, whatever a run asked for.** They are
    // what says how high a chassis carries its hull and which piece each module
    // draws, for every vehicle the run publishes. A narrowed run that leaves
    // them out does not fail: it republishes 120 tier X vehicles with no hull
    // position and no modules at all, which draws every one of them sunk into
    // its own tracks. Twenty-three megabytes against that.
    if (SCRIPT_PACKAGE.test(block.name)) {
      out.set(block.name, block);
      continue;
    }
    // **A narrowed run drops other tiers, never the packages a vehicle's own
    // files can hide in.** See `ALWAYS`.
    if (settings.packages && !settings.packages.some((p) => block.name.includes(p)) && !ALWAYS.test(block.name)) continue;
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
  /**
   * The model sets to take, when the run is not taking every one of them.
   *
   * Handed in rather than read here because it comes out of the client itself:
   * the customization tree names them, and that tree is only on disk once the
   * scripts package has been swept, which is the sweep before all the others.
   */
  skins: ReadonlySet<string> = new Set(),
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
        ...PREFAB_GLOBS,
        ...CUSTOMIZATION_GLOBS,
        ...DECAL_GLOBS,
        ...skinGlobs(settings, skins),
      ];
  // **`-ssc-` because the client does not spell its own folders consistently.**
  // 7z matches a pattern case sensitively on every platform but Windows, and the
  // IS-4 keeps its belt in `Track/` where every other vehicle keeps it in
  // `track/`: read with the case on, that vehicle simply has no link and
  // publishes no belt at all. The client is building on Windows, where the two
  // are the same folder, so the spelling means nothing and matching it exactly
  // is what invents the difference. The same slip has already cost this mirror
  // eleven vehicles' albedo textures.
  execFileSync("7z", ["x", pkg, "-ssc-", ...globs.map((g) => `-i!${g}`), `-o${work}`, "-y"], { stdio: "ignore" });
  fs.rmSync(pkgDir, { recursive: true, force: true });
}

/**
 * The vehicle folders a sweep produced, in a stable order.
 *
 * **A 3D style comes back as a vehicle whose code carries its folder.** It is
 * one, as far as everything downstream is concerned: a full set of pieces with
 * textures of its own, read from `normal/lod0` and written beside its parent.
 * Every path in the conversion is built as `vehicles/<nation>/<code>/...`, so a
 * code of `R97_Object_140/_skins/hardline` lands on the style's own folder at
 * both ends without a single new path. That is what the note on `skins` in
 * `model.ts` meant by "only a different folder".
 *
 * Nothing is listed here unless `--skins` pulled it, so a run without the flag
 * behaves exactly as it did.
 */
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
      const skins = path.join(nationDir, code, SKIN_FOLDER);
      if (!fs.existsSync(skins)) continue;
      for (const skin of fs.readdirSync(skins).sort()) {
        if (!fs.statSync(path.join(skins, skin)).isDirectory()) continue;
        out.push({ nation, code: `${code}/${SKIN_FOLDER}/${skin}` });
      }
    }
  }
  return out;
}
