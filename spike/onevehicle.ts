// Rebuild one vehicle, whole, from sources already on disk.
//
// The full generator sweeps 25 GB of packages and takes an hour and a half,
// which is the wrong tool for looking at one tank. Given a source tree pulled
// once — `generate-models --vehicle <code>` keeps one and says where — this
// redoes every conversion the generator would, geometry and textures alike, in
// seconds. Nothing is carried over from a previous mirror, so a change anywhere
// in the pipeline shows up here without a rebuild.
//
// usage: onevehicle <sources>/vehicles/<nation>/<code> <out dir>
import fs from "node:fs";
import path from "node:path";
import { mergeShapes, readCollision } from "../lib/collision.js";
import { readVehicleIdentity, readVehicleScripts } from "../lib/script.js";
import type { ChassisWheel } from "../lib/chassis.js";
import { readTrackPath } from "../lib/track.js";
import { texturePath } from "../lib/material.js";
import { VehicleBuilder } from "../lib/vehicle.js";
import type { VehicleModel } from "../lib/model.js";
import { convertCamouflage, convertTexture, TextureQuality } from "../lib/texture.js";
import { readSkinMarks, readStyles, type Style2D } from "../lib/style.js";
import { nameFor, readCatalogue } from "../lib/localization.js";
import { readMarks } from "../lib/insignia.js";

const [, , source, out] = process.argv;
if (!source || !out) throw new Error("usage: onevehicle <the vehicle's source dir> <out dir>");

const content = source.split("/vehicles/")[1];
const [nation, code] = content.split("/");
const target = path.join(out, "vehicles", nation, code);
fs.mkdirSync(target, { recursive: true });

const sources = source.split("/vehicles/")[0];

/**
 * Convert one set of pieces into one folder of the mirror.
 *
 * A vehicle and one of its 3D styles are the same thing to everything below:
 * a `normal/lod0` of pieces, sometimes a `track`, and textures named by the
 * materials inside them. A style lives one folder deeper and carries its own
 * maps, so it is published one folder deeper too and the viewer reaches it by
 * the same path it reaches any vehicle.
 */
async function convertSet(from: string, into: string, wheels: Record<string, ChassisWheel>, hullPosition: number[] | null, fallback?: string) {
  fs.mkdirSync(into, { recursive: true });
  const builder = new VehicleBuilder();

  // A style replaces the pieces the script says it replaces, and no others.
  //
  // The union of what is on disk is not the same question. A style that keeps
  // the vehicle's hull and an extraction that lost the style's hull look
  // identical from the filesystem, and quietly inheriting in both cases turns a
  // missing file into a plausible-looking tank. `missing` below is what tells
  // them apart, and it says so out loud.
  const pieces = new Map<string, string>();
  for (const dir of [fallback, from]) {
    if (!dir) continue;
    const lod0 = path.join(dir, "normal", "lod0");
    if (!fs.existsSync(lod0)) continue;
    for (const file of fs.readdirSync(lod0)) {
      if (!file.endsWith(".visual_processed")) continue;
      pieces.set(path.basename(file, ".visual_processed"), lod0);
    }
  }
  if (pieces.size === 0) return null;
  for (const name of [...pieces.keys()].sort()) {
    const lod0 = pieces.get(name)!;
    const prim = path.join(lod0, `${name}.primitives_processed`);
    if (!fs.existsSync(prim)) continue;
    const glb = builder.add(name, fs.readFileSync(path.join(lod0, `${name}.visual_processed`)), fs.readFileSync(prim));
    if (glb) fs.writeFileSync(path.join(into, `${name}.glb`), glb);
  }

  // The track: one link, and the closed path it is laid along. A style reuses
  // the vehicle's own, since it restyles the hull rather than the running gear.
  const trackDir = path.join(source, "track");
  if (fs.existsSync(trackDir)) {
    for (const file of fs.readdirSync(trackDir).sort()) {
      const full = path.join(trackDir, file);
      // Taken by the name the client gave it, and nothing else. Most vehicles
      // ship a file per side; the builder is what mirrors a lone one, and doing
      // it here as well overwrote a real path with the mirror of the other side,
      // which on a tank that is not quite symmetrical moves a belt by 30 mm.
      if (file.endsWith(".track")) {
        const read = readTrackPath(fs.readFileSync(full));
        if (read) builder.track(path.basename(file, ".track"), read.points);
      }
      // **The link is not always called `segment`.** The Maus ships
      // `segment1` and `segment2`, the ST-B1 `segment_1` and `segment_2`, and
      // matching the name exactly left those vehicles with a track path and no
      // link, which the viewer answers by drawing a plain ribbon. Any visual in
      // this folder is the link, which is what the catalogue generator has
      // always done.
      if (file.endsWith(".visual_processed")) {
        const prim = path.join(trackDir, `${path.basename(file, ".visual_processed")}.primitives_processed`);
        if (!fs.existsSync(prim)) continue;
        const glb = builder.add(VehicleBuilder.TRACK_SEGMENT, fs.readFileSync(full), fs.readFileSync(prim));
        if (glb) fs.writeFileSync(path.join(into, `${VehicleBuilder.TRACK_SEGMENT}.glb`), glb);
      }
    }
  }

  // Textures are **converted**, not copied, and only the ones this set names.
  //
  // They used to be lifted from a mirror that already had them, on the reasoning
  // that a geometry change cannot affect a texture. True, and beside the point:
  // every change to the texture pipeline then needed a full catalogue rebuild to
  // see at all, which is hours for one tank.
  //
  // The list comes from the pieces just read rather than from walking the tree:
  // a source tree pulled for one vehicle still holds every other vehicle of its
  // tier, and converting all of those is minutes for nothing. It also picks up
  // the textures a nation shares — the track maps live outside the vehicle's own
  // folder, and without them the belt vanishes, since its material alpha-tests
  // against a map that never loads.
  const converted: string[] = [];
  for (const client of builder.textures) {
    for (const at of [client, client.replace(/\.dds$/, "_hd.dds")]) {
      const dds = path.join(sources, at);
      if (!fs.existsSync(dds)) continue;
      const file = path.join(out, texturePath(at));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        await convertTexture(dds, file, undefined, at.endsWith("_hd.dds") ? TextureQuality.High : TextureQuality.Standard);
        converted.push(texturePath(at));
      } catch (e) {
        // One texture in a layout we cannot read is not a reason to publish no
        // vehicle. The material entry naming it is dropped, which is what the
        // viewer already copes with, and the name is said so it can be looked at.
        console.log(`  ! ${at.split("/").pop()}: ${(e as Error).message.trim()}`);
      }
    }
  }

  builder.declareWheels(wheels);
  // Exactly what was written, so a material naming anything else has its entry
  // dropped rather than pointing at a file that is not there.
  const model = builder.build(new Set(converted), hullPosition);
  return model;
}

const collision: Record<string, unknown> = {};
const collisionDir = path.join(source, "collision_client");
if (fs.existsSync(collisionDir)) {
  for (const file of fs.readdirSync(collisionDir).sort()) {
    if (!file.endsWith(".havok")) continue;
    collision[path.basename(file, ".havok")] = mergeShapes(readCollision(fs.readFileSync(path.join(collisionDir, file))));
  }
}

const scripts = readVehicleScripts(path.join(sources, "scripts", "item_defs", "vehicles"));
const script = scripts.get(content);
const customization = path.join(sources, "scripts", "item_defs", "customization");
const identity = readVehicleIdentity(path.join(sources, "scripts", "item_defs", "vehicles"), code);

/** The shapes and the thicknesses, which every style of a vehicle shares. */
function writeCollision(into: string): void {
  fs.writeFileSync(
    path.join(into, "collision.json"),
    `${JSON.stringify({
      parts: collision,
      armor: script?.armor ?? {},
      spaced: script?.spaced ?? {},
      hullPosition: script?.hullPosition ?? null,
      mounts: script?.mounts ?? { turret: null, guns: {}, yaw: {}, pitch: {} },
    })}\n`,
  );
}

// Converted once, then worn by the vehicle and by every one of its styles that
// does not bring marks of its own.
const marks = await writeMarks(identity ? readMarks(customization, identity.nation) : []);

/**
 * Give a set of pieces the slots it takes a mark in, and the marks themselves.
 *
 * Every set gets these, the vehicle's own and each of its 3D styles alike: a
 * mark of excellence is earned on the tank and shows whatever the player has it
 * wearing, so a style that carried none left the picker with nothing to offer.
 * A slot naming one style belongs to that style alone, which is why the list is
 * filtered rather than copied.
 */
async function dressUp(model: VehicleModel, skin: string | null): Promise<void> {
  const slots = Object.entries(script?.slots ?? {})
    .filter(([piece]) => model.pieces[piece])
    .map(([piece, list]) => [piece, list.filter((slot) => !slot.model || slot.model === skin)] as const)
    .filter(([, list]) => list.length > 0);
  if (slots.length > 0) model.slots = Object.fromEntries(slots);
  const camouflage = Object.entries(script?.camouflage ?? {}).filter(([piece]) => model.pieces[piece]);
  if (camouflage.length > 0) model.camouflage = Object.fromEntries(camouflage);
  if (identity) model.camouflageDensity = identity.density;
  // A style can bring its own marks, and hundreds do. The slot on the gun is
  // the vehicle's either way: only the picture changes.
  const own = skin ? await writeMarks(readSkinMarks(customization, skin)) : [];
  const wearing = own.length > 0 ? own : marks;
  if (wearing.length > 0) model.marks = wearing;
}

// The vehicle's own styles, each a complete set of pieces with maps of its own.
const skinDir = path.join(source, "_skins");
const skins = fs.existsSync(skinDir) ? fs.readdirSync(skinDir).sort() : [];
for (const skin of skins) {
  // What the script names for this style, against what the client ships.
  //
  // The script lists a full set of pieces for every style whether or not they
  // differ, so a name here is a template rather than a promise: 48 of the 143
  // styles in the client ship no hull of their own, and 33 of those are Battle
  // Pass styles, which restyle the running gear and the turret and leave the
  // hull to the vehicle. The gap is normal and the inheritance below is the
  // right answer to it. It is still worth saying, because the same gap is what
  // a lost file looks like.
  const declared = script?.sets[skin] ?? {};
  const absent = Object.entries(declared).filter(
    ([, at]) => !fs.existsSync(path.join(sources, at.replace(/\.model$/, ".visual_processed"))),
  );
  if (absent.length > 0) {
    console.log(`  ${skin}: keeps the vehicle's own ${absent.map(([piece]) => piece).join(", ")}`);
  }
  const built = await convertSet(path.join(skinDir, skin), path.join(target, "_skins", skin), script?.wheels ?? {}, script?.hullPosition ?? null, source);
  if (!built) continue;
  await dressUp(built, skin);
  fs.writeFileSync(path.join(target, "_skins", skin, "model.json"), `${JSON.stringify(built)}\n`);
  // A style repaints a vehicle, it does not rearmour it, so it carries the same
  // collision. Written into the style's folder rather than looked up from the
  // vehicle's, which keeps a style reachable by exactly the path a vehicle is.
  writeCollision(path.join(target, "_skins", skin));
}

/**
 * The 2D styles the client offers on this vehicle, with their patterns.
 *
 * Only the base vehicle takes them: a 3D style is already a complete look and
 * the client does not let a player paint over one, so a style folder gets no
 * list and the viewer offers no choice there.
 *
 * Patterns are converted once each. A style is a recipe rather than a picture,
 * and hundreds of them share a few hundred patterns between them.
 */
async function writeStyles(into: string): Promise<Style2D[]> {
  const dir = customization;
  if (!fs.existsSync(dir) || !identity) return [];
  const styles = readStyles(dir, identity);
  // A style names itself with a key. Without the catalogue a viewer offers
  // `generic_custom_look_ussr` where the game offers "Made in the U.S.S.R.".
  const catalogue = await readCatalogue("vehicle_customization").catch(() => new Map<string, string>());

  const written = new Map<string, string>();
  /**
   * Each pattern's own pixel size, which the computed tiling path divides by,
   * and how many of its channels are weights.
   */
  const patterns = new Map<string, { size: [number, number]; weights: 3 | 4 }>();
  const kept: Style2D[] = [];
  for (const style of styles) {
    const outfits = [];
    for (let outfit of style.outfits) {
      // The stickers and the lettering, published where the client keeps them:
      // the same few hundred serve every vehicle in the catalogue.
      const decals = [];
      for (const decal of outfit.decals) {
        const dds = path.join(sources, decal.texture);
        if (!fs.existsSync(dds)) continue;
        const at = texturePath(decal.texture);
        if (!written.has(decal.texture)) {
          const file = path.join(out, at);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          await convertTexture(dds, file, undefined, TextureQuality.High);
          written.set(decal.texture, at);
        }
        decals.push({ ...decal, texture: at });
      }
      // A style that brings its own marks of excellence brings the files too.
      // The decals projected into the vehicle's own slots, published the same
      // way and from the same folder as the stickers.
      const projected = [];
      for (const decal of outfit.projected) {
        const dds = path.join(sources, decal.texture);
        if (!fs.existsSync(dds)) continue;
        const at = texturePath(decal.texture);
        if (!written.has(decal.texture)) {
          const file = path.join(out, at);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          await convertTexture(dds, file, undefined, TextureQuality.High);
          written.set(decal.texture, at);
        }
        projected.push({ ...decal, texture: at });
      }
      outfit = { ...outfit, decals, projected, marks: await writeMarks(outfit.marks) };
      // Every camouflage the outfit names, since a style can dress a hull, a
      // turret and a gun in three different patterns.
      const worn = [];
      for (const camouflage of outfit.camouflages) {
        if (!written.has(camouflage.texture)) {
          const dds = path.join(sources, camouflage.texture);
          if (!fs.existsSync(dds)) continue;
          // Published where the client keeps it rather than under the vehicle: a
          // pattern belongs to no vehicle in particular and the same several
          // hundred serve the whole catalogue.
          const at = texturePath(camouflage.texture);
          const file = path.join(out, at);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          patterns.set(camouflage.texture, await convertCamouflage(dds, file));
          written.set(camouflage.texture, at);
        }
        // The maps that give the coat its finish, published beside the pattern.
        // A camouflage that names one the packages do not carry simply goes
        // without it rather than being dropped: the pattern is what it is.
        const finish = async (at: string | null) => {
          if (!at) return null;
          const dds = path.join(sources, at);
          if (!fs.existsSync(dds)) return null;
          const to = texturePath(at);
          if (!written.has(at)) {
            const file = path.join(out, to);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await convertTexture(dds, file, undefined, TextureQuality.High);
            written.set(at, to);
          }
          return to;
        };
        const glossMetallicMap = await finish(camouflage.glossMetallicMap);
        const normalMap = await finish(camouflage.normal?.texture ?? null);
        const emissionMap = await finish(camouflage.emission?.texture ?? null);
        worn.push({
          ...camouflage,
          texture: written.get(camouflage.texture)!,
          size: patterns.get(camouflage.texture)?.size ?? null,
          weights: patterns.get(camouflage.texture)?.weights ?? 4,
          glossMetallicMap,
          normal: normalMap && camouflage.normal ? { ...camouflage.normal, texture: normalMap } : null,
          emission: emissionMap && camouflage.emission ? { ...camouflage.emission, texture: emissionMap } : null,
        });
      }
      outfits.push({ ...outfit, camouflages: worn });
    }
    // A style whose every pattern is missing from the packages is a style that
    // cannot be shown, which is a different thing from one that has no pattern.
    // `?empty?` is the catalogue's own placeholder for an entry with nothing
    // behind it, and eleven styles on the IS-7 carry it. A style the client
    // will not name is one it does not intend to show.
    const name = nameFor(style.name, catalogue);
    if (outfits.length > 0 && !name.startsWith("?")) kept.push({ ...style, name, outfits });
  }
  // Sorted on the name a player reads, which is only known once the catalogue
  // has been applied.
  kept.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(into, "styles2d.json"), `${JSON.stringify(kept)}\n`);
  console.log(`  ${kept.length} 2D styles, ${written.size} patterns`);
  return kept;
}

const model = await convertSet(source, target, script?.wheels ?? {}, script?.hullPosition ?? null);
if (!model) throw new Error(`${content} has no pieces`);
// The styles are listed on the vehicle, so a viewer can offer them without
// having to go looking for a folder that is usually not there.
if (skins.length > 0) model.skins = skins;
await dressUp(model, null);
/**
 * The marks of excellence, converted for this vehicle's nation.
 *
 * They are the same ten files for the whole catalogue, so they are published
 * where the client keeps them rather than under the vehicle, and the vehicle
 * only names the three that are its own.
 */
async function writeMarks(paths: string[]): Promise<string[]> {
  const published: string[] = [];
  for (const at of paths) {
    const dds = path.join(sources, at);
    if (!fs.existsSync(dds)) continue;
    const file = path.join(out, texturePath(at));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await convertTexture(dds, file, undefined, TextureQuality.High);
    published.push(texturePath(at));
  }
  return published;
}

if ((await writeStyles(target)).length > 0) model.styles = "styles2d.json";
fs.writeFileSync(path.join(target, "model.json"), `${JSON.stringify(model)}\n`);
writeCollision(target);
console.log(`${content}: ${Object.keys(model.pieces).length} pieces, ${Object.keys(collision).length} collision parts, ${model.wheels?.length ?? 0} wheels, tracks ${model.tracks ? "yes" : "no"}, ${skins.length} skins`);
