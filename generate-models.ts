// Generator for the `unicum-gg/wot.models` mirror: the vehicle geometry the
// script mirrors leave out, pulled from the client on the update CDN with no
// game installed.
//
// `wot.src` publishes what a vehicle *is* (its scripts, its armor thicknesses)
// but not its shape, because the meshes are binary. That gap is what stops a
// site from drawing a tank, so this fills it and only it.
//
// Two things come out of a vehicle. Its **collision**, one Havok file per piece,
// is the armor geometry: shapes named after the plates the vehicle's own armor
// table lists, which is what an armor viewer draws. Its **model** is the visual
// mesh and its textures, published as glTF and WebP so a browser needs no
// converter in front of it.
//
// Pieces of one vehicle are split across a tier's `-partN` packages, so every
// package is converted as it is swept and the results are accumulated: waiting
// for a whole vehicle would mean holding every package on disk at once.
//
// Usage: npm run models -- --host H --guid G --out DIR [--package NAME]
//        [--vehicle CODE] [--collision-only] [--texture-size N] [--force]
//
// `--package` takes a comma-separated list of substrings, which is how a run is
// narrowed to one tier while still reaching the shared textures it needs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive } from "./lib/archive.js";
import { readVehicleScripts, type VehicleScripts } from "./lib/script.js";
import { indexPaths } from "./lib/material.js";
import { TRACK_SEGMENT, type VehicleModel } from "./lib/model.js";
import { VehicleBuilder } from "./lib/vehicle.js";
import { resolveClient } from "./lib/wgus.js";
import {
  convertCollision,
  convertDecals,
  convertPieces,
  convertTextures,
  convertTrack,
  readMeasured,
  writeMeasured,
  type Measured,
} from "./lib/models/convert.js";
import { publish } from "./lib/models/publish.js";
import { lockedModelSets, readLockedStyles } from "./lib/locked-styles.js";
import { demand, family, movedFamilies, readFingerprints, writeFingerprints, type Fingerprints } from "./lib/models/fingerprint.js";
import { log, readSettings, SkinScope } from "./lib/models/settings.js";
import {
  accumulate,
  packages,
  SKIN_FOLDER,
  sweep,
  swept,
  HD_SHARED_PACKAGE,
  SCRIPT_PACKAGE,
  SHARED_PACKAGE,
  type Catalogue,
} from "./lib/models/sweep.js";

const settings = readSettings(process.argv.slice(2));
const vehicles: Catalogue = new Map();
/**
 * What each camouflage pattern measured, taken as it was converted.
 *
 * Seeded from the mirror, since a run that skips an unchanged package measures
 * none of its patterns and the styles it resolves still name them.
 */
const patterns: Measured = readMeasured(settings.out);

/** Whether a swept code is the vehicle asked for, or one of its 3D styles. */
const isOrDresses = (code: string, only: string) =>
  code === only || code.startsWith(`${only}/${SKIN_FOLDER}/`);

/** Convert everything the current sweep holds, then empty the scratch tree. */
async function drain(work: string, converted: Set<string>, scripts: VehicleScripts, last = false): Promise<void> {
  for (const vehicle of swept(work)) {
    // A vehicle's 3D styles come with it: their codes carry the folder they
    // sit in, so an exact match alone would build the tank and drop the very
    // styles a single-vehicle run is usually asking to look at.
    if (settings.only && !isOrDresses(vehicle.code, settings.only)) continue;
    const into = accumulate(vehicles, vehicle);
    try {
      convertCollision(work, vehicle, into, settings);
      if (!settings.collisionOnly) {
        convertPieces(work, vehicle, into, settings, scripts, last);
        convertTrack(work, vehicle, into, settings);
      }
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code}: ${(e as Error).message}`);
    }
  }
  if (!settings.collisionOnly) {
    const referenced = settings.only
      ? indexPaths([...vehicles.values()].flatMap((v) => [...v.model.textures]))
      : undefined;
    const textures = await convertTextures(work, converted, patterns, settings, referenced);
    if (textures > 0) log(`  ${textures} textures`);
  }
  // Everything converted has been deleted as it was consumed. What is left is
  // waiting for a file a later package holds, so the tree is not cleared.
}

/**
 * Pull the scripts package out ahead of everything else.
 *
 * It lives in the `client` part, which is read last, so a vehicle's geometry
 * would otherwise be converted before anything is known about it. Opened
 * against its own archive and left in `opened` for the same cleanup as the
 * rest; the part is walked again in the normal order afterwards, where the
 * package is a no-op because its files are already on disk.
 */
async function sweepScripts(
  client: Awaited<ReturnType<typeof resolveClient>>,
  opened: SparseArchive[],
  work: string,
): Promise<void> {
  if (!client) return;
  const chain = client.getChain("client");
  if (chain.length === 0) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotmodels-"));
  const archive = await SparseArchive.open(dir, chain[0].volumes);
  opened.push(archive);
  for (const [name, block] of packages(archive, settings)) {
    if (!SCRIPT_PACKAGE.test(name)) continue;
    await sweep(archive, block, work, settings);
    await archive.reset();
    return;
  }
}

async function main(): Promise<void> {
  log(`resolving ${settings.guid} via ${settings.host}`);
  const client = await resolveClient(settings.host, settings.guid);
  if (!client) {
    log(`${settings.guid}: no build published, nothing to mirror`);
    return;
  }
  log(`client ${client.versionName} (host ${client.host})`);

  const versionFile = path.join(settings.out, ".version_name");
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
  if (current === client.versionName && !settings.force) {
    log(`already at ${client.versionName}, nothing to do`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wotmodels-work-"));
  const converted = new Set<string>();
  const opened: SparseArchive[] = [];
  // **What the mirror was last built from**, so a build that moved three
  // packages costs three packages. Empty under `--force`, which is what makes
  // that flag mean "as if nothing had ever been mirrored": the version guard
  // above is about the client changing, this is about the client changing in
  // places, and a run that wants everything redone has to pass both.
  const asked = demand(settings);
  // **Read whatever the run is about to do with them.** `--force` decides as if
  // nothing had ever been mirrored, but it must not FORGET what was: a run
  // narrowed to one tier records only that tier, so dropping the rest here
  // would leave `packages.json` describing the last slice alone and every other
  // one would be swept again on the next build. Which is exactly the shape the
  // optional styles have to be filled in, one tier at a time.
  const recorded: Fingerprints = readFingerprints(settings.out, asked);
  const held: Fingerprints = settings.force ? {} : recorded;
  const seen: Fingerprints = {};
  try {
    // **The scripts come first, before any geometry.** They used to be read at
    // the end, which was enough while everything they answered was about the
    // published manifest. A piece's animation is not: the client keeps it in a
    // prefab and only the scripts say which prefab a gun plays, so a gun
    // converted before them would be built without its mechanism and never
    // looked at again. `scripts.pkg` is 23 MB, so reading it up front costs
    // nothing next to the tiers it now precedes.
    await sweepScripts(client, opened, work);
    const scripts = readVehicleScripts(path.join(work, "scripts", "item_defs", "vehicles"));
    // **Which 3D styles this run has to carry, decided from the client rather
    // than from a list.** A style bolted onto a vehicle is that vehicle's only
    // appearance, so its models are as much a part of the mirror as any hull.
    // Read here because it needs the customization tree the scripts package
    // just put on disk, and needed here because every sweep after this one is
    // where those files would be taken from.
    const locked = readLockedStyles(path.join(work, "scripts", "item_defs", "customization"));
    const skins = settings.skins === SkinScope.All ? new Set<string>() : lockedModelSets(locked);
    log(
      settings.skins === SkinScope.All
        ? `${locked.length} styles locked onto a vehicle, pulling every 3D style`
        : `${locked.length} styles locked onto a vehicle, ${skins.size} model sets to pull`,
    );
    for (const part of settings.skipHd ? ["sdcontent", "client"] : ["sdcontent", "hdcontent", "client"]) {
      const chain = client.getChain(part);
      if (chain.length === 0) continue;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotmodels-"));
      const archive = await SparseArchive.open(dir, chain[0].volumes);
      opened.push(archive);
      const blocks = packages(archive, settings);
      if (blocks.size === 0) continue;
      log(`${part}: ${blocks.size} packages`);
      // Scripts first, then vehicles, then the shared textures: a shared texture
      // is only known to be needed once some material has asked for it, which is
      // what narrows a single-vehicle run.
      const rank = (name: string) =>
        // Ordering only, and a guess at that now that names have been shown to
        // mean nothing: read anything script-shaped first so the vehicle list
        // exists, and anything shared-shaped last so its textures are already
        // known to be wanted. A package that lies about itself just lands in
        // the middle, which costs a little work and no correctness.
        SCRIPT_PACKAGE.test(name) ? 0 : SHARED_PACKAGE.test(name) || HD_SHARED_PACKAGE.test(name) ? 2 : 1;
      const ordered = [...blocks].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
      // Decided for the whole part before any of it is swept, since what a
      // package's siblings did is part of the answer for that package.
      const moved = movedFamilies(held, blocks.values());
      let skipped = 0;
      for (const [name, block] of ordered) {
        seen[name] = block.crc;
        // **Unchanged means untouched: not downloaded, not extracted, not
        // converted.** The mirror already holds what this package produced, and
        // the run is about to be handed that tree to publish into, so there is
        // nothing for a sweep to add. The scripts are the exception and are
        // always read: everything downstream is keyed off them, from which
        // vehicle draws which geometry to which style is bolted onto what, and
        // they are 23 MB.
        if (!SCRIPT_PACKAGE.test(name) && !moved.has(family(name))) {
          skipped++;
          continue;
        }
        await sweep(archive, block, work, settings, skins);
        await drain(work, converted, scripts);
        log(`  ${path.basename(name)} (${(block.packed / 1e6).toFixed(0)} MB block), ${vehicles.size} vehicles so far`);
        // Blocks stay in the sparse volumes once filled, so walking every
        // package would materialise the whole part on disk.
        await archive.reset();
      }
      if (skipped > 0) log(`  ${skipped} package(s) unchanged, left alone`);
    }

    // Nothing else is coming, so anything still waiting on a file is converted
    // with whatever it has.
    await drain(work, converted, scripts, true);
    const codes = [...scripts.drawnBy.values()].reduce((n, list) => n + list.length, 0);
    log(`${codes} vehicles read, drawing from ${scripts.drawnBy.size} sets of geometry`);
    const decals = await convertDecals(work, converted, settings);
    if (decals > 0) log(`${decals} decals, marks and stickers`);
    // Before the publish and not after it: the publish writes the root files
    // into this folder, and until now the folder only existed because some
    // vehicle's own conversion had created it on its way past. A run that
    // converted nothing at all, which is every run narrowed to a vehicle that
    // turns out to be in another package, died on ENOENT instead of saying so.
    fs.mkdirSync(settings.out, { recursive: true });
    const { vehicles: written, bytes } = await publish(work, converted, scripts, vehicles, patterns, settings);
    fs.writeFileSync(versionFile, `${client.versionName}\n`);
    // **Written after the publish, and only then.** These are a claim about
    // what the mirror holds, so recording them before the files are on disk
    // would let a run that died half way tell the next one there was nothing
    // left to do.
    writeFingerprints(settings.out, asked, { ...recorded, ...seen });
    writeMeasured(settings.out, patterns);
    log(`done: ${written} vehicles, ${converted.size} textures, ${(bytes / 1e6).toFixed(1)} MB of metadata`);
    // A vehicle carrying a link but no path means its `.track` was not read,
    // which is invisible in the output: the viewer just falls back to the
    // ribbon and the track looks passable.
    //
    // **Counted off what was published, not off what was built.** A vehicle
    // that borrows another's link is given it after its model is written, so
    // read from the builder the Churchill St. Gloriana still had no belt here
    // and the line said zero about a run that had just laid one. And the piece
    // is named after the file the link came out of, so the bare `TrackSegment`
    // this used to look for is a key no vehicle has ever had: the second half
    // of this line has been reporting zero since it was written.
    let laid = 0;
    let linkOnly = 0;
    for (const key of vehicles.keys()) {
      const at = path.join(settings.out, "vehicles", key, "model.json");
      if (!fs.existsSync(at)) continue;
      const model = JSON.parse(fs.readFileSync(at, "utf8")) as VehicleModel;
      if (model.tracks) laid++;
      else if (Object.keys(model.pieces).some((piece) => piece.startsWith(`${TRACK_SEGMENT}_`))) linkOnly++;
    }
    log(`${laid} vehicles have a real track, ${linkOnly} have a link but no path`);
  } finally {
    for (const a of opened) fs.rmSync(a.dir, { recursive: true, force: true });
    // Asked for one vehicle, keep what came out of the packages.
    //
    // Pulling a vehicle's sources down is minutes of network; converting them is
    // seconds. Throwing the sources away means every change to a texture or a
    // mesh costs the download again, which is how an afternoon goes on rebuilds.
    // Kept, `spike/onevehicle.ts` reconverts from them instantly.
    if (settings.only) log(`sources kept for ${settings.only}: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
