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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive, type Block } from "./lib/archive.js";
import { decodeDDS } from "./lib/dds.js";
import { mergeShapes, readCollision, type CollisionPart } from "./lib/collision.js";
import { CUSTOMIZATION_GLOBS, readVehicleIdentity, readVehicleScripts, VEHICLE_SCRIPTS_GLOB, type VehicleScript } from "./lib/script.js";
import { readStyles, type Style2D } from "./lib/style.js";
import { readMarks } from "./lib/insignia.js";
import { nameFor, readCatalogue } from "./lib/localization.js";
import { readTrackPath, TRACK_GLOB } from "./lib/track.js";
import {
  convertCamouflage,
  convertTexture,
  patternWeights,
  textureRole,
  TextureQuality,
  TextureRole,
} from "./lib/texture.js";
import { VehicleBuilder, texturePath, type VehicleModel } from "./lib/vehicle.js";
import { resolveClient } from "./lib/wgus.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const HOST = flag("--host") ?? "wgus-woteu.wargaming.net";
const GUID = flag("--guid") ?? "WOT.EU.PRODUCTION";
const OUT = path.resolve(flag("--out") ?? "models-out");
const ONLY = flag("--vehicle");
const PACKAGE = flag("--package")?.split(",").filter(Boolean);
/**
 * Both sets are published at the size the client ships them.
 *
 * There is no reason to resize what is already the source. The client has 2048
 * on a tier ten hull where we were publishing 1024, and halving it threw away
 * exactly the relief a player looks for when they switch to HD. The standard
 * set had the same problem a size down: the client's own SD hull is 1024 and we
 * were capping it at 512, so our SD was half the game's SD rather than being it.
 *
 * Pass `--texture-size` or `--hd-texture-size` to cap either one if a build
 * ever has to trade the fidelity for the bytes.
 */
const TEXTURE_SIZE = flag("--texture-size") ? Number(flag("--texture-size")) : undefined;
const HD_TEXTURE_SIZE = flag("--hd-texture-size") ? Number(flag("--hd-texture-size")) : undefined;
const SKIP_HD = args.includes("--no-hd");
const COLLISION_ONLY = args.includes("--collision-only");
const WITH_SKINS = args.includes("--skins");

/**
 * Drop a source once it has been converted.
 *
 * The scratch tree is fed 25 GB of packages, so anything consumed goes as it is
 * consumed or the disk fills. A single-vehicle run is the exception and the
 * whole point of one: its sources are what makes the next iteration seconds
 * instead of ten minutes of network, so nothing is thrown away there.
 */
const consume = (at: string) => {
  if (!ONLY) fs.rmSync(at);
};
const FORCE = args.includes("--force");

// Vehicles ship in the per-tier packages, but the textures a nation shares
// between its vehicles (every track, and the maps a whole nation draws with) sit
// in the shared packages instead, so both have to be walked or a material would
// reference a texture that was never published. The `_sandbox` ones are not a
// test mode despite the name: a fifth of all vehicles have their track textures
// there and nowhere else.
const SHARED_PACKAGE = /^res\/packages\/shared_content(?:_sandbox)?(?:-part\d+)?\.pkg$/;
// The client ships its textures twice, and only its textures: `hdcontent` holds
// no geometry at all, just a `*_hd.dds` beside each `*.dds` at twice the side.
// Both are published so a viewer can offer the choice, and the geometry, which
// is the same either way, is never duplicated.
const HD_SHARED_PACKAGE = /^res\/packages\/shared_content(?:_sandbox)?_hd(?:-part\d+)?\.pkg$/;
// The scripts, read for the one number the meshes do not carry: how high a
// chassis holds its hull.
const SCRIPT_PACKAGE = /^res\/packages\/scripts\.pkg$/;

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

// Shipped beside a vehicle's own textures but never drawn: a baked shadow the
// garage puts under the tank.
const NON_TEXTURE = /HangarShadowMap/i;

const log = (msg: string) => console.log(`[wot.models] ${msg}`);

type Vehicle = { nation: string; code: string };
type Accumulated = {
  collision: Record<string, CollisionPart>;
  model: VehicleBuilder;
};

const vehicles = new Map<string, Accumulated>();

function accumulate(vehicle: Vehicle): Accumulated {
  const key = `${vehicle.nation}/${vehicle.code}`;
  let entry = vehicles.get(key);
  if (!entry) {
    entry = { collision: {}, model: new VehicleBuilder() };
    vehicles.set(key, entry);
  }
  return entry;
}

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
function packages(archive: SparseArchive): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const block of archive.index().values()) {
    if (!/packages\/.+\.pkg$/.test(block.name)) continue;
    if (PACKAGE && !PACKAGE.some((p) => block.name.includes(p))) continue;
    out.set(block.name, block);
  }
  return out;
}

/** Unpack the parts of one package we read, into a scratch tree. */
async function sweep(archive: SparseArchive, block: Block, work: string): Promise<void> {
  const pkgDir = path.join(archive.dir, "pkg");
  fs.rmSync(pkgDir, { recursive: true, force: true });
  const pkg = await archive.extract(block, pkgDir);
  // The same patterns for every package, because the name says nothing about
  // what is inside: a package called `particles` holds a vehicle's hull. Asking
  // 7z for a few extra patterns costs nothing next to reading the block, and it
  // is what makes the sweep depend on paths alone.
  const globs = COLLISION_ONLY
    ? [COLLISION_GLOB]
    : [
        COLLISION_GLOB,
        ...VISUAL_GLOBS,
        ...SHARED_GLOBS,
        VEHICLE_SCRIPTS_GLOB,
        ...CUSTOMIZATION_GLOBS,
        ...DECAL_GLOBS,
        ...(WITH_SKINS ? SKIN_GLOBS : []),
      ];
  execFileSync("7z", ["x", pkg, ...globs.map((g) => `-i!${g}`), `-o${work}`, "-y"], { stdio: "ignore" });
  fs.rmSync(pkgDir, { recursive: true, force: true });
}

/** The vehicle folders a sweep produced, in a stable order. */
function swept(work: string): Vehicle[] {
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

function vehicleOut(vehicle: Vehicle): string {
  const dir = path.join(OUT, "vehicles", vehicle.nation, vehicle.code);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function convertCollision(work: string, vehicle: Vehicle, into: Accumulated): void {
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
    consume(full);
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
function convertPieces(work: string, vehicle: Vehicle, into: Accumulated): void {
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
      if (glb) fs.writeFileSync(path.join(vehicleOut(vehicle), `${name}.glb`), glb);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} ${name}: ${(e as Error).message}`);
    }
    // Dropped either way: a piece that failed once fails every time, and
    // keeping it would have the sweep retry it against every later package.
    consume(visual);
    consume(primitives);
  }
}

/**
 * Convert a vehicle's track: the path its belt follows and the link laid along
 * it. Both halves are needed, so neither is published without the other.
 */
function convertTrack(work: string, vehicle: Vehicle, into: Accumulated): void {
  const dir = path.join(work, "vehicles", vehicle.nation, vehicle.code, "track");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, file);
    if (file.endsWith(".track")) {
      const parsed = readTrackPath(fs.readFileSync(full));
      if (parsed) into.model.track(path.basename(file, ".track"), parsed.points);
      consume(full);
      continue;
    }
    if (!file.endsWith(".visual_processed")) continue;
    const name = path.basename(file, ".visual_processed");
    const primitives = path.join(dir, `${name}.primitives_processed`);
    if (!fs.existsSync(primitives)) continue;
    try {
      const glb = into.model.add(VehicleBuilder.TRACK_SEGMENT, fs.readFileSync(full), fs.readFileSync(primitives));
      if (glb) fs.writeFileSync(path.join(vehicleOut(vehicle), `${VehicleBuilder.TRACK_SEGMENT}.glb`), glb);
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code} track link: ${(e as Error).message}`);
    }
    consume(full);
    consume(primitives);
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
async function convertTextures(work: string, into: Set<string>, wanted?: Set<string>): Promise<number> {
  const root = path.join(work, "vehicles");
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  /**
   * A camouflage pattern is not a picture and is not sampled like one.
   *
   * Its four channels are weights rather than colours, so all four are kept,
   * and it is laid several times across a hull rather than read pixel for
   * pixel, so it is capped well below what the client ships. Some arrive at
   * 2048, which over the several hundred a single vehicle is offered is 158 MB
   * of blotch.
   */
  const inCamouflage = /[/\\]Camouflage[/\\]/i;
  // **Not everything in that folder is a pattern.** The same folder holds each
  // camouflage's own gloss-metal, relief and emission maps, and those are
  // ordinary textures: put through the pattern path they keep the client's
  // channel order, and a coat of paint renders as rust.
  const isPattern = (at: string) => inCamouflage.test(at) && textureRole(at) === TextureRole.Other;
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
        consume(full);
        continue;
      }
      const target = path.join(OUT, texturePath(relative));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        if (isPattern(relative)) await convertCamouflage(full, target);
        else {
          await convertTexture(
            full,
            target,
            hd ? HD_TEXTURE_SIZE : TEXTURE_SIZE,
            hd ? TextureQuality.High : TextureQuality.Standard,
          );
        }
        into.add(relative);
        count++;
      } catch (e) {
        log(`  ! texture ${relative}: ${(e as Error).message}`);
      }
      consume(full);
    }
  };
  await walk(root);
  return count;
}

/** Convert everything the current sweep holds, then empty the scratch tree. */
async function drain(work: string, converted: Set<string>): Promise<void> {
  for (const vehicle of swept(work)) {
    if (ONLY && vehicle.code !== ONLY) continue;
    const into = accumulate(vehicle);
    try {
      convertCollision(work, vehicle, into);
      if (!COLLISION_ONLY) {
        convertPieces(work, vehicle, into);
        convertTrack(work, vehicle, into);
      }
    } catch (e) {
      log(`  ! ${vehicle.nation}/${vehicle.code}: ${(e as Error).message}`);
    }
  }
  if (!COLLISION_ONLY) {
    const referenced = ONLY
      ? new Set([...vehicles.values()].flatMap((v) => [...v.model.textures]))
      : undefined;
    const textures = await convertTextures(work, converted, referenced);
    if (textures > 0) log(`  ${textures} textures`);
  }
  // Everything converted has been deleted as it was consumed. What is left is
  // waiting for a file a later package holds, so the tree is not cleared.
}

/**
 * The stickers, the lettering and the marks of excellence.
 *
 * These live under `gui/` rather than under a vehicle, because the same few
 * hundred serve the whole catalogue, so they are converted once at the end of a
 * run rather than per vehicle. A single-vehicle run skips them: it is the
 * dev path, and `spike/onevehicle.ts` converts exactly the ones it needs.
 */
async function convertDecals(work: string, into: Set<string>): Promise<number> {
  const root = path.join(work, "gui");
  if (ONLY || !fs.existsSync(root)) return 0;
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
      const target = path.join(OUT, texturePath(relative));
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

/** Whether a converted path is a camouflage's weight map rather than one of its
 * material maps, which share the folder. */
const isPatternPath = (at: string) => /[/\\]Camouflage[/\\]/i.test(at) && textureRole(at) === TextureRole.Other;

/** Write the accumulated collision and model files, returning what was written. */
async function publish(
  work: string,
  converted: Set<string>,
  scripts: Map<string, VehicleScript>,
): Promise<{ vehicles: number; bytes: number }> {
  const published = new Set([...converted].map(texturePath));
  const vehicleScripts = path.join(work, "scripts", "item_defs", "vehicles");
  const customization = path.join(work, "scripts", "item_defs", "customization");
  // A style names itself with a key. Without the catalogue a viewer offers
  // `generic_custom_look_ussr` where the game offers "Made in the U.S.S.R.".
  const catalogue = await readCatalogue("vehicle_customization").catch(() => new Map<string, string>());
  /**
   * Each camouflage pattern's own pixel size, which the computed tiling path
   * divides by. Read from the client's file rather than from what is published,
   * since the conversion caps the side.
   */
  const patterns = new Map<string, { size: [number, number]; weights: 3 | 4 }>();
  for (const at of converted) {
    if (!isPatternPath(at)) continue;
    try {
      const { width, height, rgba } = decodeDDS(fs.readFileSync(path.join(work, at)));
      patterns.set(at, { size: [width, height], weights: patternWeights(rgba, width * height) });
    } catch {
      // A pattern we cannot measure falls back to the shader's own default.
    }
  }

  /** One vehicle's 2D styles, resolved and kept only where the mirror has them. */
  const wearable = (identity: ReturnType<typeof readVehicleIdentity>, have: Set<string>): Style2D[] => {
    if (!identity || !fs.existsSync(customization)) return [];
    const out: Style2D[] = [];
    for (const style of readStyles(customization, identity)) {
      const outfits = style.outfits
        .map((outfit) => ({
          ...outfit,
          // The computed tiling path divides by the pattern's own pixel size, so
          // it travels with the pattern.
          camouflages: outfit.camouflages.map((c) => {
            // The finish maps share the pattern's folder and are published the
            // same way. One the packages do not carry is dropped rather than
            // left pointing at a file that is not there.
            const kept = (at: string | null) => (at && have.has(texturePath(at)) ? texturePath(at) : null);
            const normal = kept(c.normal?.texture ?? null);
            const emission = kept(c.emission?.texture ?? null);
            return {
              ...c,
              texture: texturePath(c.texture),
              size: patterns.get(c.texture)?.size ?? null,
              weights: patterns.get(c.texture)?.weights ?? 4,
              glossMetallicMap: kept(c.glossMetallicMap),
              normal: normal && c.normal ? { ...c.normal, texture: normal } : null,
              emission: emission && c.emission ? { ...c.emission, texture: emission } : null,
            };
          }),
          decals: outfit.decals.map((d) => ({ ...d, texture: texturePath(d.texture) })),
          projected: outfit.projected.map((d) => ({ ...d, texture: texturePath(d.texture) })),
        }))
        // A style whose pattern the packages do not carry cannot be shown.
        .filter(
          (outfit) =>
            outfit.camouflages.every((c) => have.has(c.texture)) &&
            outfit.decals.every((d) => have.has(d.texture)) &&
            outfit.projected.every((d) => have.has(d.texture)),
        );
      // `?empty?` is the catalogue's own placeholder for an entry with nothing
      // behind it. A style the client will not name is one it does not show.
      const name = nameFor(style.name, catalogue);
      if (outfits.length > 0 && !name.startsWith("?")) out.push({ ...style, name, outfits });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  let written = 0;
  let bytes = 0;
  for (const [key, entry] of vehicles) {
    const [nation, code] = key.split("/");
    const dir = path.join(OUT, "vehicles", nation, code);
    const script = scripts.get(key);
    const files: [string, unknown][] = [];
    // Geometry and thickness travel together: a shape named `armor_5` and the
    // 270 mm the vehicle's own table gives it are each useless alone, and a
    // viewer that had to fetch them separately could draw one without the other.
    if (Object.keys(entry.collision).length > 0) {
      files.push([
        "collision.json",
        {
          parts: entry.collision,
          armor: script?.armor ?? {},
          spaced: script?.spaced ?? {},
          hullPosition: script?.hullPosition ?? null,
          mounts: script?.mounts ?? { turret: null, guns: {}, yaw: {}, pitch: {} },
        },
      ]);
    }
    if (!entry.model.empty) {
      entry.model.declareWheels(script?.wheels ?? {});
      const model = entry.model.build(published, script?.hullPosition ?? null) satisfies VehicleModel;
      // Where the vehicle takes a mark, an emblem or an inscription. Only the
      // pieces it actually publishes, so a viewer never reads a slot for a
      // turret it is not showing.
      const slots = Object.fromEntries(Object.entries(script?.slots ?? {}).filter(([piece]) => model.pieces[piece]));
      if (Object.keys(slots).length > 0) model.slots = slots;
      // How each piece stretches a camouflage, and how much the vehicle does as
      // a whole. Both feed the tiling, and without them every pattern lands at
      // the wrong size.
      const camouflage = Object.entries(script?.camouflage ?? {}).filter(([piece]) => model.pieces[piece]);
      if (camouflage.length > 0) model.camouflage = Object.fromEntries(camouflage);

      const identity = readVehicleIdentity(vehicleScripts, code);
      if (identity) {
        model.camouflageDensity = identity.density;
        const marks = readMarks(customization, identity.nation).map(texturePath).filter((at) => published.has(at));
        if (marks.length > 0) model.marks = marks;
        // The 2D styles, each a recipe naming a camouflage, some paint and some
        // decals. Kept out of the manifest because it is a long list nothing
        // needs until a player opens the paint shop.
        const styles = wearable(identity, published);
        if (styles.length > 0) {
          model.styles = "styles2d.json";
          files.push(["styles2d.json", styles]);
        }
      }
      files.push(["model.json", model]);
    }
    if (files.length === 0) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of files) {
      const json = `${JSON.stringify(body)}\n`;
      fs.writeFileSync(path.join(dir, name), json);
      bytes += Buffer.byteLength(json);
    }
    written++;
  }
  return { vehicles: written, bytes };
}

async function main(): Promise<void> {
  log(`resolving ${GUID} via ${HOST}`);
  const client = await resolveClient(HOST, GUID);
  if (!client) {
    log(`${GUID}: no build published, nothing to mirror`);
    return;
  }
  log(`client ${client.versionName} (host ${client.host})`);

  const versionFile = path.join(OUT, ".version_name");
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
  if (current === client.versionName && !FORCE) {
    log(`already at ${client.versionName}, nothing to do`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wotmodels-work-"));
  const converted = new Set<string>();
  const opened: SparseArchive[] = [];
  try {
    for (const part of SKIP_HD ? ["sdcontent", "client"] : ["sdcontent", "hdcontent", "client"]) {
      const chain = client.getChain(part);
      if (chain.length === 0) continue;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotmodels-"));
      const archive = await SparseArchive.open(dir, chain[0].volumes);
      opened.push(archive);
      const blocks = packages(archive);
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
        await sweep(archive, block, work);
        await drain(work, converted);
        log(`  ${path.basename(name)} (${(block.packed / 1e6).toFixed(0)} MB block), ${vehicles.size} vehicles so far`);
        // Blocks stay in the sparse volumes once filled, so walking every
        // package would materialise the whole part on disk.
        await archive.reset();
      }
    }

    const scripts = readVehicleScripts(path.join(work, "scripts", "item_defs", "vehicles"));
    log(`${scripts.size} vehicle scripts read`);
    const decals = await convertDecals(work, converted);
    if (decals > 0) log(`${decals} decals, marks and stickers`);
    const { vehicles: written, bytes } = await publish(work, converted, scripts);
    fs.mkdirSync(OUT, { recursive: true });
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
      else if (model.pieces[VehicleBuilder.TRACK_SEGMENT]) linkOnly++;
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
    if (ONLY) log(`sources kept for ${ONLY}: ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
