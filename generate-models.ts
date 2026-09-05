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
import { TRACK_SEGMENT } from "./lib/model.js";
import { VehicleBuilder } from "./lib/vehicle.js";
import { resolveClient } from "./lib/wgus.js";
import {
  convertCollision,
  convertDecals,
  convertPieces,
  convertTextures,
  convertTrack,
  type Measured,
} from "./lib/models/convert.js";
import { publish } from "./lib/models/publish.js";
import { log, readSettings } from "./lib/models/settings.js";
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
/** What each camouflage pattern measured, taken as it was converted. */
const patterns: Measured = new Map();

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
      ? new Set([...vehicles.values()].flatMap((v) => [...v.model.textures]))
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
      for (const [name, block] of ordered) {
        await sweep(archive, block, work, settings);
        await drain(work, converted, scripts);
        log(`  ${path.basename(name)} (${(block.packed / 1e6).toFixed(0)} MB block), ${vehicles.size} vehicles so far`);
        // Blocks stay in the sparse volumes once filled, so walking every
        // package would materialise the whole part on disk.
        await archive.reset();
      }
    }

    // Nothing else is coming, so anything still waiting on a file is converted
    // with whatever it has.
    await drain(work, converted, scripts, true);
    const codes = [...scripts.drawnBy.values()].reduce((n, list) => n + list.length, 0);
    log(`${codes} vehicles read, drawing from ${scripts.drawnBy.size} sets of geometry`);
    const decals = await convertDecals(work, converted, settings);
    if (decals > 0) log(`${decals} decals, marks and stickers`);
    const { vehicles: written, bytes } = await publish(work, converted, scripts, vehicles, patterns, settings);
    fs.mkdirSync(settings.out, { recursive: true });
    fs.writeFileSync(versionFile, `${client.versionName}\n`);
    log(`done: ${written} vehicles, ${converted.size} textures, ${(bytes / 1e6).toFixed(1)} MB of metadata`);
    // A vehicle carrying a link but no path means its `.track` was not read,
    // which is invisible in the output: the viewer just falls back to the
    // ribbon and the track looks passable.
    let laid = 0;
    let linkOnly = 0;
    for (const entry of vehicles.values()) {
      const model = entry.model.build(new Set(), null);
      if (model.tracks) laid++;
      else if (model.pieces[TRACK_SEGMENT]) linkOnly++;
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
