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
import { readVehicleIdentity, type VehicleScript } from "../script.js";
import { readStyles, type Style2D } from "../style.js";
import { patternWeights } from "../texture.js";
import { texturePath } from "../material.js";
import type { VehicleModel } from "../model.js";
import type { Measured } from "./convert.js";
import type { Settings } from "./settings.js";
import type { Catalogue } from "./sweep.js";

/** Write the accumulated collision and model files, returning what was written. */
export async function publish(
  work: string,
  converted: Set<string>,
  scripts: Map<string, VehicleScript>,
  vehicles: Catalogue,
  patterns: Measured,
  settings: Settings,
): Promise<{ vehicles: number; bytes: number }> {
  const published = new Set([...converted].map(texturePath));
  const vehicleScripts = path.join(work, "scripts", "item_defs", "vehicles");
  const customization = path.join(work, "scripts", "item_defs", "customization");
  // A style names itself with a key. Without the catalogue a viewer offers
  // `generic_custom_look_ussr` where the game offers "Made in the U.S.S.R.".
  const names = await readCatalogue("vehicle_customization").catch(() => new Map<string, string>());
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
      const name = nameFor(style.name, names);
      if (outfits.length > 0 && !name.startsWith("?")) out.push({ ...style, name, outfits });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  let written = 0;
  let bytes = 0;
  for (const [key, entry] of vehicles) {
    const [nation, code] = key.split("/");
    const dir = path.join(settings.out, "vehicles", nation, code);
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
