// Writing a vehicle out: its armor, its model, and the styles it can wear.
//
// Everything here reads what the sweep accumulated rather than the scratch tree,
// with one exception: a camouflage pattern's own pixel size, which the computed
// tiling divides by and which the conversion caps, so it is measured on the
// client's file before that happens.
import fs from "node:fs";
import path from "node:path";
import { decodeDDS } from "../dds.js";
import { readMarks } from "../insignia.js";
import { nameFor, readCatalogue } from "../localization.js";
import { readVehicleIdentity } from "../identity.js";
import type { VehicleScripts } from "../script.js";
import { readLockedStyles } from "../locked-styles.js";
import { readSkinNames, type Style2D } from "../style.js";
import { wearableStyles } from "./wearable.js";
import { patternWeights } from "../texture.js";
import { indexPaths, TEXTURE_EXTENSION, texturePath } from "../material.js";
import type { VehicleModel } from "../model.js";
import { fold } from "./catalogue.js";
import { SKIN_FOLDER, type Catalogue } from "./sweep.js";
import type { Measured } from "./convert.js";
import { log, type Settings } from "./settings.js";

/** Write the accumulated collision and model files, returning what was written. */
/** The client's grey stand-in for a vehicle it no longer ships. */
const PLACEHOLDER = /_Placeholder$/;

/**
 * Drop the materials no piece draws with, renumbering the ones that stay.
 *
 * **Grafting appends a whole list to keep the arithmetic simple**, and a
 * manifest that is grafted into on run after run would carry the donor's list
 * again every time: a vehicle whose pieces arrive from two packages would grow
 * its material list at every incremental build until it is mostly dead weight.
 * A material is reachable only through a mesh, so what nothing names can go.
 */
function compact(model: VehicleModel): void {
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
function readManifest(at: string): VehicleModel | null {
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
function graft(model: VehicleModel, donor: VehicleModel, pieces: string[], from = ""): void {
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

/**
 * Every texture the mirror already carries, by the path a material names it at.
 *
 * Walked rather than remembered: the mirror is a git checkout of a branch, so
 * what is on disk is the whole truth about what a previous run published, and
 * nothing has to be kept in step with it.
 */
function mirrored(out: string): string[] {
  // **The whole mirror, not its vehicles.** A material names a texture from the
  // root, and plenty of them sit outside `vehicles/`: the marks of excellence
  // and every sticker live under `gui/maps/vehicles/decals`, which arrive in
  // their own packages. Walked from `vehicles/` alone, a run that did not sweep
  // those packages could not resolve a single mark, and every vehicle it
  // rebuilt was published with none, silently, having had them the run before.
  const root = out;
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(TEXTURE_EXTENSION)) found.push(path.relative(out, full));
    }
  };
  walk(root);
  return found;
}

export async function publish(
  work: string,
  converted: Set<string>,
  scripts: VehicleScripts,
  vehicles: Catalogue,
  patterns: Measured,
  settings: Settings,
): Promise<{ vehicles: number; bytes: number }> {
  // **What a material may name: what this run converted, plus what the mirror
  // already holds.** A run that skipped an unchanged package converted none of
  // its textures, and a vehicle rebuilt beside it still names them: resolved
  // against this run alone, every one of those references would be dropped and
  // the vehicle published with no paint on it. The published path of a texture
  // is its client path with another extension, which is also where it sits
  // under `out`, so the tree answers the question directly.
  const published = indexPaths([
    ...[...converted].map(texturePath),
    ...mirrored(settings.out),
  ]);
  const vehicleScripts = path.join(work, "scripts", "item_defs", "vehicles");
  const customization = path.join(work, "scripts", "item_defs", "customization");
  // A style names itself with a key. Without the catalogue a viewer offers
  // `generic_custom_look_ussr` where the game offers "Made in the U.S.S.R.".
  const names = await readCatalogue("vehicle_customization").catch(() => new Map<string, string>());
  // Read once, before anything is written: it answers two questions in this
  // file, which vehicle wears what and which model sets belong to nobody else.
  const locked = readLockedStyles(customization);
  /** The sets a vehicle is issued wearing, whichever vehicle that is. */
  const issued = new Set(locked.map((l) => l.models).filter(Boolean));
  /** One vehicle's 2D styles, resolved and kept only where the mirror has them. */
  /** Every style the mirror publishes, written once at the root. */
  const catalogue = new Map<number, Style2D>();
  /** Where each drawable vehicle sits, which is also the list of what exists. */
  const index: Record<string, string> = {};
  /**
   * Which 3D styles each vehicle came back with, gathered before anything is
   * written.
   *
   * A style is published as a vehicle in its own right and the map is walked
   * once, so the parent may well be reached before its styles: read as we went,
   * half of them would be missing from the list they belong on.
   */
  const dressed = new Map<string, string[]>();
  for (const key of vehicles.keys()) {
    const at = key.indexOf(`/${SKIN_FOLDER}/`);
    if (at < 0) continue;
    const parent = key.slice(0, at);
    const name = key.slice(at + SKIN_FOLDER.length + 2);
    dressed.set(parent, [...(dressed.get(parent) ?? []), name]);
  }
  let written = 0;
  let bytes = 0;
  for (const [key, entry] of vehicles) {
    // **Not `split("/")`, which stopped at two.** A style's key carries its
    // folder, `russian/R97_Object_140/_skins/hardline`, and taking the second
    // segment as the code would have written it over the vehicle it dresses.
    const nation = key.slice(0, key.indexOf("/"));
    const code = key.slice(nation.length + 1);
    const skin = code.includes(`/${SKIN_FOLDER}/`);
    const dir = path.join(settings.out, "vehicles", nation, code);
    const script = scripts.scripts.get(key);
    // **A 3D style is a set of models for a vehicle, not a vehicle.** The client
    // keeps no script under its name, so everything the tank *is* has to be read
    // from the tank it dresses: the same wheels on the same arms carrying the
    // same guns, drawn in another coat.
    //
    // Read from its own key alone, a style came out with none of it. Its guns
    // went back to the stock barrel the moment one was put on, and on the
    // thirteen vehicles that kneel, every wheel counted as bolted to the body,
    // so a tank in a style deployed with its running gear held rigid.
    //
    // Only what the vehicle *is* travels: the shells stay on the vehicle's own
    // key below, because a style has no armour of its own and the viewer reads
    // that from the tank either way.
    const worn =
      script ??
      (skin
        ? scripts.scripts.get(key.slice(0, key.indexOf(`/${SKIN_FOLDER}/`)))
        : undefined);
    const files: [string, unknown][] = [];
    // Geometry and thickness travel together: a shape named `armor_5` and the
    // 270 mm the vehicle's own table gives it are each useless alone, and a
    // viewer that had to fetch them separately could draw one without the other.
    // **Written for the assembly, not only for the armour.** Where each piece
    // hangs off the one below it comes from the script and has nothing to do
    // with the Havok shells: gated on those, 19 vehicles whose armour did not
    // convert lost their mounts too and drew every piece stacked at the origin.
    // **Armour borrowed from the tank a variant was made from.** A variant ships
    // its own textures and its own visual model and no Havok shells at all: its
    // hit testers name another vehicle's folder, and the client reads them from
    // there. Thirteen playable tanks are in that case, the Ashbringer and the
    // Pz 58 Mutz among them, and without this they have no armour view.
    //
    // Taken piece by piece from the path the client writes, never from a code's
    // prefix: the Skorpian's armour is the Skorpion's, which no prefix rule
    // would have found.
    const shells = { ...entry.collision };
    for (const [piece, from] of Object.entries(script?.shells ?? {})) {
      if (shells[piece] || from === key) continue;
      const donor = vehicles.get(from)?.collision?.[piece];
      if (donor) shells[piece] = donor;
    }
    if (Object.keys(shells).length > 0 || script) {
      files.push([
        "collision.json",
        {
          parts: shells,
          armor: script?.armor ?? {},
          spaced: script?.spaced ?? {},
          hullPosition: script?.hullPosition ?? null,
          // Which piece each module draws, under the game's own name for it.
          // **Written here as well as beside the meshes**, because the mounts
          // above are read per piece: where the gun hangs depends on the turret
          // carrying it, and what it can do depends on the gun. A reader who
          // upgrades either would otherwise get the new barrel drawn on the old
          // turret's mount, aiming to the stock gun's limits.
          modules: script?.modules ?? {},
          // The way it aims while it drives, and beside it the way it aims
          // once planted. Two states rather than one, because a vehicle that
          // deploys has two and reading them as one describes neither.
          mounts: {
            ...(script?.mounts ?? { turret: null, guns: {}, yaw: {}, pitch: {} }),
            ...(script?.siege ? { siege: script.siege } : {}),
          },
        },
      ]);
    }
    if (!entry.model.empty) {
      entry.model.declareWheels(worn?.wheels ?? {});
      entry.model.declareSpline(worn?.spline ?? null, worn?.chain ?? null);
      entry.model.declareCarried(worn?.carried ?? []);
      entry.model.declareModules(worn?.modules ?? {});
      const model = entry.model.build(published, worn?.hullPosition ?? null) satisfies VehicleModel;
      // Where the vehicle takes a mark, an emblem or an inscription. Only the
      // pieces it actually publishes, so a viewer never reads a slot for a
      // turret it is not showing.
      const slots = Object.fromEntries(Object.entries(worn?.slots ?? {}).filter(([piece]) => model.pieces[piece]));
      if (Object.keys(slots).length > 0) model.slots = slots;
      // How each piece stretches a camouflage, and how much the vehicle does as
      // a whole. Both feed the tiling, and without them every pattern lands at
      // the wrong size.
      const camouflage = Object.entries(worn?.camouflage ?? {}).filter(([piece]) => model.pieces[piece]);
      if (camouflage.length > 0) model.camouflage = Object.fromEntries(camouflage);

      // **What this vehicle may be dressed in, which is not everything sitting
      // in its `_skins` folder.** A style locked onto a vehicle is published
      // under the geometry that vehicle borrows, so the Monkey King's livery
      // lands beside the plain 121B's meshes and offering the folder's contents
      // as they are puts a style in the 121B's wardrobe that the game gives
      // only to another tank. The vehicle wearing it reaches it through
      // `worn.json` instead, which is not a choice anyone makes.
      const styles = (dressed.get(key) ?? []).filter((set) => !issued.has(set));
      if (styles.length > 0) model.skins = styles.sort();
      const identity = skin ? null : readVehicleIdentity(vehicleScripts, code);
      if (identity) {
        model.camouflageDensity = identity.density;
        const marks = readMarks(customization, identity.nation)
          .map((at) => published.at(texturePath(at)))
          .filter((at): at is string => at !== null);
        if (marks.length > 0) model.marks = marks;
        // The 2D styles, each a recipe naming a camouflage, some paint and some
        // decals. Kept out of the manifest because it is a long list nothing
        // needs until a player opens the paint shop.
        const styles = wearableStyles(identity, published, {
          customization,
          patterns,
          names,
        });
        if (styles.length > 0) {
          model.styles = "styles2d.json";
          files.push([
            "styles2d.json",
            fold(catalogue, styles, (why) => log(`  ! ${nation}/${code}: ${why}`)),
          ]);
        }
      }
      // **A material that lost every texture is borrowed from, and that is worth
      // saying out loud.** `finishMaterials` fills an empty one from the
      // richest material the vehicle has, which is right for the ones the
      // client ships empty and is a quiet lie when the textures were simply not
      // swept: a track whose maps live in a package this run skipped comes back
      // painted like the gun, which draws a belt nobody can see rather than no
      // belt at all. Named here because the manifest is where it lands.
      const borrowed = model.materials.filter((material) => material.inheritedFrom);
      if (borrowed.length > 0) {
        log(
          `  ? ${key}: ${borrowed.length} material(s) took another's textures (${borrowed
            .map((m) => `${m.name} <- ${m.inheritedFrom}`)
            .join(", ")})`,
        );
      }
      // **A run never takes a piece off a vehicle the mirror already has.**
      //
      // The pieces of one vehicle are not all in one package: the Erlang Shen's
      // style keeps its chassis with the tier and its hull, turret and gun in
      // `particles.pkg`. A run that swept one of those and skipped the other,
      // which is exactly what an incremental run does, rebuilds the vehicle out
      // of the half it saw. Written over the manifest, that silently publishes
      // a tank with no hull, and nothing says so: the file is valid, the viewer
      // draws what it is given.
      //
      // So what was published stays unless this run has something to put in its
      // place. The cost is that a piece the game really removed survives until
      // a full `--force` rebuild, which is the trade the tournament mirror makes
      // for the same reason: a gap that repairs itself beats a hole nobody sees.
      const held = readManifest(path.join(dir, "model.json"));
      if (held) {
        graft(model, held, Object.keys(held.pieces).filter((piece) => !model.pieces[piece]));
        // **And everything else a piece carries with it.** A slot says where a
        // mark or an emblem goes and is read from the piece's own visual, so a
        // run that did not sweep the gun publishes a vehicle with nowhere to put
        // its marks of excellence: the mark is named, the texture is never even
        // fetched, and the control does nothing. The camouflage measurements are
        // per piece for the same reason.
        model.slots = { ...held.slots, ...model.slots };
        model.camouflage = { ...held.camouflage, ...model.camouflage };
        if (!Object.keys(model.slots).length) delete model.slots;
        if (!Object.keys(model.camouflage).length) delete model.camouflage;
        compact(model);
      }
      files.push(["model.json", model]);
      // Indexed on the model, not on the vehicle: six of the catalogue's
      // variants publish a collision and no meshes, having none of their own,
      // and a viewer that trusted the index would ask for a model that is not
      // there.
      //
      // **Every code drawing from this geometry is indexed, not just the one
      // that named the folder.** A quarter of the catalogue reaches its meshes
      // under another name: an event reskin, a clan reissue, or a vehicle whose
      // code and folder simply drifted apart, `R43_T-70` against `R43_T70`.
      // Publishing only the folder's own name is what left those looking, to a
      // consumer, like vehicles the mirror does not carry.
      // **The client's placeholder is not an answer.** A handful of vehicles
      // the game has retired still sit in its lists pointing at
      // `R00_Placeholder`, a grey stand-in shipped so the client has something
      // to load. Indexing them to it would trade a picture of the vehicle for a
      // grey box, so they are left to fall back like the vehicles they are.
      // **A style is not a vehicle anyone asks for.** It is reached through the
      // vehicle it dresses, so indexing it would put a hull nobody can name
      // beside the tanks in the manifest.
      if (!skin && !PLACEHOLDER.test(code)) {
        for (const drawing of scripts.drawnBy.get(key) ?? [code]) index[drawing] = key;
        index[code] = key;
      }
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
  // **The index describes the mirror, not the run.**
  //
  // A run that skipped every unchanged package built a handful of vehicles, and
  // the index is the list of what a consumer may ask for: written from the run
  // alone it would say the mirror holds a handful, and every other vehicle on
  // the site would fall back to a photograph with its meshes sitting right
  // there. So it is completed from the client's own account of who draws what,
  // kept to the folders the mirror actually has on disk.
  //
  // That is also what retires a vehicle the game has dropped: the scripts no
  // longer mention it, so nothing indexes it, even though its files are still
  // in the branch.
  for (const [key, codes] of scripts.drawnBy) {
    if (key.includes(`/${SKIN_FOLDER}/`)) continue;
    const code = key.slice(key.indexOf("/") + 1);
    if (PLACEHOLDER.test(code)) continue;
    if (!fs.existsSync(path.join(settings.out, "vehicles", key, "model.json"))) continue;
    for (const drawing of codes) index[drawing] = key;
    index[code] = key;
  }

  // **Where each vehicle is, and therefore which ones exist at all.**
  //
  // A consumer knows a vehicle by the code the game gives it, `R45_IS-7`, and
  // what it cannot work out is where that vehicle's geometry sits. Two things
  // stand in the way and only the client answers either. The nation folder is
  // not the nation the scripts name, `russian` against `ussr`. And the folder is
  // not always the vehicle's own code: a quarter of the catalogue draws from
  // another vehicle's meshes, an event reskin or a code that drifted from the
  // folder made for it, `R43_T-70` against `R43_T70`.
  //
  // So what is published is the path itself, `russian/R45_IS-7`, rather than the
  // nation half of it. Publishing only the nation is what made every one of
  // those 236 vehicles unreachable: the index said which nation to look under
  // and the consumer, having no better guess, looked under the vehicle's own
  // code, where there was nothing.
  //
  // So the mapping is published. It doubles as the list of what the mirror
  // carries: a site draws from a catalogue wider than this one, and this is how
  // it knows to fall back to a picture rather than ask for a model that is not
  // there.
  if (written > 0) {
    const json = `${JSON.stringify(Object.fromEntries(Object.entries(index).sort()))}\n`;
    fs.writeFileSync(path.join(settings.out, "vehicles.json"), json);
    bytes += Buffer.byteLength(json);

    // **Which vehicle each one was made from**, where the client says so.
    //
    // Two ways it says it, and both mean the same thing to a reader: a vehicle
    // can draw another's meshes, which the index above already records, or ship
    // meshes of its own and point every hit tester at another's armour, which
    // is how a reskin like the Ashbringer is built. Either way it is that tank
    // wearing something else, and that is worth saying on its page.
    //
    // Codes rather than names, because the mirror is read out of the game
    // client and knows nothing of the catalogue a site routes by. Whoever has
    // that catalogue resolves them.
    const from: Record<string, string> = {};
    for (const [code, at] of Object.entries(index)) {
      const drawn = at.slice(at.indexOf("/") + 1);
      if (drawn !== code) from[code] = drawn;
    }
    // Walked over every script rather than over this run's vehicles, for the
    // same reason the index is: a vehicle nobody rebuilt today is still one the
    // mirror carries, and its donor is still worth saying on its page.
    for (const [key, script] of scripts.scripts) {
      const code = key.slice(key.indexOf("/") + 1);
      if (from[code] || code.includes("/")) continue;
      const donor = Object.values(script.shells).find((at) => at !== key);
      if (donor) from[code] = donor.slice(donor.indexOf("/") + 1);
    }
    const based = `${JSON.stringify(Object.fromEntries(Object.entries(from).sort()))}\n`;
    fs.writeFileSync(path.join(settings.out, "based-on.json"), based);
    bytes += Buffer.byteLength(based);
  }

  // **The belt a variant borrows, once every vehicle is on disk.**
  //
  // A variant ships no `track/` folder of its own and says so outright: its
  // `splineDesc` names the link and both paths in another vehicle's folder,
  // the way its hit testers name that vehicle's armour. Read only from its own
  // folder it comes out with no belt at all, and the viewer falls back to the
  // flat ribbon the chassis carries: the wheels turn and the track does not.
  //
  // Done in a pass of its own because it reads the donor's published model, and
  // during the loop above there is no saying which of the two was written yet.
  //
  // A 3D style is the same rule seen from the other side: it is a set of models
  // for a vehicle, not a vehicle, and it ships no belt at all. All 270 of them
  // take their own tank's, which is what the game does with them.
  for (const key of [...vehicles.keys()]) {
    const at = path.join(settings.out, "vehicles", key, "model.json");
    if (!fs.existsSync(at)) continue;
    const model = JSON.parse(fs.readFileSync(at, "utf8")) as VehicleModel;
    if (model.tracks) continue;
    const dressed = key.indexOf(`/${SKIN_FOLDER}/`);
    const script = scripts.scripts.get(key);
    const named = script?.spline?.left ?? script?.spline?.models.left;
    const from =
      dressed >= 0
        ? key.slice(0, dressed)
        : /^vehicles\/([^/]+\/[^/]+)\//i.exec(named ?? "")?.[1];
    if (!from || from === key) continue;
    const donorAt = path.join(settings.out, "vehicles", from, "model.json");
    if (!fs.existsSync(donorAt)) continue;
    const donor = JSON.parse(fs.readFileSync(donorAt, "utf8")) as VehicleModel;
    if (!donor.tracks || !donor.pieces[donor.tracks.segment]) continue;
    borrowBelt(settings.out, key, from, model, donor);
    fs.writeFileSync(at, JSON.stringify(model));
  }

  // **A style is only the pieces it replaces, and the rest of the tank has to
  // come from underneath.**
  //
  // The client ships a style as the parts it restyles and nothing else, which
  // is the whole point of one: the Monkey King is a 121B's running gear under a
  // new hull, so its folder holds a hull, a turret and a gun and no chassis at
  // all. Published as it arrives, the tank is drawn floating with no road
  // wheels, and nothing turns: the wheels are declared by the chassis. Measured
  // across the six styles the tier X pass produced, every one of them was
  // missing something, and one was missing its turret and its gun.
  //
  // **The inherited pieces point at the parent's files rather than copying
  // them.** A `glb` is resolved against the vehicle's own folder, so a style
  // reaches one folder up, and the textures never move at all since a material
  // names them from the root of the mirror. What has to be rewritten is the
  // material INDEX, which is a position in this manifest's own list.
  for (const key of [...vehicles.keys()]) {
    const dressed = key.indexOf(`/${SKIN_FOLDER}/`);
    if (dressed < 0) continue;
    const at = path.join(settings.out, "vehicles", key, "model.json");
    // **The folder a style sits in is not always a vehicle.** A style is
    // published under the content path its vehicle names, and a vehicle that
    // borrows another's meshes has one of those with nothing in it: the CS-63
    // OSP3 has `poland/Pl21_CS_63_OSP3/_skins/…` and no geometry of its own, so
    // the tank underneath is the one the index sends that code to.
    const folder = key.slice(0, dressed);
    const drawn = index[folder.slice(folder.indexOf("/") + 1)];
    const parentKey = fs.existsSync(path.join(settings.out, "vehicles", folder, "model.json"))
      ? folder
      : (drawn ?? folder);
    const parentAt = path.join(settings.out, "vehicles", parentKey, "model.json");
    if (!fs.existsSync(at) || !fs.existsSync(parentAt)) continue;
    // How far up and back across the inherited files are, which is two levels
    // for a style sitting in its own vehicle's folder and further for one whose
    // vehicle borrows: `../../../Pl21_CS_63`.
    const upward = path.posix.relative(`vehicles/${key}`, `vehicles/${parentKey}`);
    const model = JSON.parse(fs.readFileSync(at, "utf8")) as VehicleModel;
    const parent = JSON.parse(fs.readFileSync(parentAt, "utf8")) as VehicleModel;
    // **By family, not by name.** A vehicle carries several guns and several
    // turrets, and a style ships the one it restyles: the Vz. 55 Gothic Warrior
    // publishes `Gun_02` and nothing else, so inheriting the parent's `Gun_01`
    // by name puts an unstyled barrel back on the tank and the configurator
    // mounts it, which is what a reader sees first. A style that dresses a
    // family at all has dressed all of it, and only a family it is silent about
    // comes from underneath.
    const family = (piece: string) => piece.split("_")[0];
    const dressedFamilies = new Set(Object.keys(model.pieces).map(family));
    const missing = Object.keys(parent.pieces).filter(
      (piece) => !model.pieces[piece] && !dressedFamilies.has(family(piece)),
    );
    // **Not only the pieces.** A style inherits whatever it has no answer of its
    // own for, and a style that replaces every piece still has no marks and no
    // wheels: leaving early on a complete set of models is what left the Erlang
    // Shen, which replaces the whole tank, with no mark to put on its gun.
    if (missing.length > 0) {
      graft(model, parent, missing, upward);
      compact(model);
    }
    // What the inherited running gear needs to be more than scenery: the wheels
    // it turns on, the arms a kneeling suspension swings, and which of them ride
    // the ground. The builder writes the last two only where a vehicle has them,
    // so they are carried across by name rather than by field. A style that
    // ships its own chassis declares its own, and none of this overwrites.
    // **The marks of excellence go with the gun, whoever painted it.**
    //
    // They are read from the vehicle's identity, which a style has none of: it
    // is a set of models, not a vehicle, so nothing looked them up for it and a
    // tank wearing a locked livery came out with no marks to put on at all.
    // What the game does is the opposite, a style either brings its own three
    // or leaves the nation's, and never removes them.
    if (!model.marks?.length && parent.marks?.length) model.marks = parent.marks;
    const running = ["wheels", "levers", "carried"] as const;
    const held = model as unknown as Record<string, unknown[]>;
    const under = parent as unknown as Record<string, unknown[]>;
    for (const field of running) {
      if (!held[field]?.length && under[field]?.length) held[field] = under[field];
    }
    if (!model.camouflageDensity && parent.camouflageDensity) {
      model.camouflageDensity = parent.camouflageDensity;
    }
    fs.writeFileSync(at, JSON.stringify(model));
    if (missing.length > 0) {
      log(`  ${key} took ${missing.join(", ")} from the tank underneath`);
    }
  }

  // What each 3D style is called, so a wardrobe offers names and not folders.
  if (fs.existsSync(customization)) {
    const skins = readSkinNames(customization, names);
    if (Object.keys(skins).length > 0) {
      const json = `${JSON.stringify(Object.fromEntries(Object.entries(skins).sort()))}\n`;
      fs.writeFileSync(path.join(settings.out, "skins.json"), json);
      bytes += Buffer.byteLength(json);
      log(`${Object.keys(skins).length} named 3D styles`);
    }

    // **What a vehicle is issued already wearing**, which for most of them is
    // the only thing that makes them look like themselves.
    //
    // By vehicle code and not in the manifest, for the same reason `based-on`
    // is a file of its own: a manifest belongs to a FOLDER of geometry and
    // several vehicles read one. The Monkey King and the plain 121B share
    // `chinese/Ch25_121_mod_1971B`, so a field written there would put the
    // Monkey King's livery on the 121B as well.
    //
    // Only where the set was actually published. A run narrowed to one vehicle,
    // or one that could not reach a package, would otherwise name a folder the
    // mirror does not carry, and a viewer would ask for it and come back with
    // nothing at all rather than with the plain tank.
    const worn: Record<string, string> = {};
    for (const { code, models } of locked) {
      const at = index[code];
      if (!models || !at) continue;
      if (!fs.existsSync(path.join(settings.out, "vehicles", at, SKIN_FOLDER, models, "model.json"))) continue;
      worn[code] = models;
    }
    if (Object.keys(worn).length > 0) {
      const json = `${JSON.stringify(Object.fromEntries(Object.entries(worn).sort()))}\n`;
      fs.writeFileSync(path.join(settings.out, "worn.json"), json);
      bytes += Buffer.byteLength(json);
      log(`${Object.keys(worn).length} vehicles issued wearing a style`);
    }
  }

  // Written last, since a vehicle can only be folded in once it is resolved.
  //
  // **Merged into what the mirror holds rather than replacing it.** The recipes
  // are the same on every vehicle that can wear them, which is the whole reason
  // they are published once at the root, so a run that rebuilt three vehicles
  // resolved three vehicles' worth of them and the rest are exactly as they
  // were. Written over, that run would leave every other vehicle's patch
  // pointing at styles the catalogue no longer describes.
  if (catalogue.size > 0) {
    const at = path.join(settings.out, "styles2d.json");
    const held = new Map<number, Style2D>();
    try {
      for (const style of JSON.parse(fs.readFileSync(at, "utf8")) as Style2D[]) {
        held.set(style.id, style);
      }
    } catch {
      // No catalogue yet, or one this version cannot read: this run writes it.
    }
    for (const [id, style] of catalogue) held.set(id, style);
    const json = `${JSON.stringify([...held.values()].sort((a, b) => a.id - b.id))}\n`;
    fs.writeFileSync(at, json);
    bytes += Buffer.byteLength(json);
    log(
      held.size === catalogue.size
        ? `${held.size} styles in the shared catalogue`
        : `${held.size} styles in the shared catalogue, ${catalogue.size} of them resolved by this run`,
    );
  }
  return { vehicles: written, bytes };
}

/**
 * Take another vehicle's belt, links and all.
 *
 * **A piece cannot travel on its own.** Its meshes name materials by their place
 * in the model's own list, so a link copied across as it stands draws whatever
 * happens to sit at that index in the new one: on the M48A5 the belt's material
 * is index 1 of seven, and every style has a different seven. The materials it
 * uses come with it and the indices are rewritten.
 */
function borrowBelt(
  out: string,
  key: string,
  from: string,
  model: VehicleModel,
  donor: VehicleModel,
): void {
  const moved = new Map<number, number>();
  const bring = (index: number): number => {
    const already = moved.get(index);
    if (already !== undefined) return already;
    const material = donor.materials[index];
    if (!material) return 0;
    const at = model.materials.push(material) - 1;
    moved.set(index, at);
    return at;
  };
  for (const name of [donor.tracks!.segment, donor.tracks!.segment2]) {
    const shared = name ? donor.pieces[name] : undefined;
    if (!name || !shared) continue;
    model.pieces[name] = {
      ...shared,
      meshes: shared.meshes.map((mesh) => ({
        ...mesh,
        materials: mesh.materials.map(bring),
      })),
    };
    fs.copyFileSync(
      path.join(out, "vehicles", from, shared.glb),
      path.join(out, "vehicles", key, shared.glb),
    );
  }
  model.tracks = donor.tracks;
}
