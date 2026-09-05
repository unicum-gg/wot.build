// Which 2D styles a vehicle can actually be shown in.
//
// **A style the packages do not carry cannot be worn.** The client declares far
// more than any one extraction brings back, and a style whose pattern is missing
// would reach a viewer as an entry that paints nothing. So every outfit is
// checked against what was really written, and the pattern's own pixel size
// travels with it, since the computed tiling divides by it and the conversion
// caps it.
import fs from "node:fs";
import { nameFor } from "../localization.js";
import { texturePath } from "../material.js";
import { readStyles, type Style2D } from "../style.js";
import type { VehicleIdentity } from "../identity.js";
import type { Measured } from "./convert.js";

export function wearableStyles(
  identity: VehicleIdentity | null,
  /** Every texture the mirror actually wrote, by its published path. */
  have: Set<string>,
  { customization, patterns, names }: {
    /** The client's customization tree, where the styles are declared. */
    customization: string;
    /** Each pattern's own pixel size, measured before the conversion caps it. */
    patterns: Measured;
    /** What the client calls each style, so a viewer offers a name not a key. */
    names: Map<string, string>;
  },
): Style2D[] {
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
}
