// The style a vehicle is issued already wearing.
//
// **A reward vehicle is very often not a vehicle at all.** It is another tank
// plus a style the client bolts onto it and never lets the player take off: the
// Monkey King is a 121B wearing `Ch25_121_mod_1971B_MC_3DSt`, the Churchill
// BPXIV is a Churchill VII wearing its own, and 32 of the 40 vehicles in this
// state ship no geometry of their own at all, so the mirror indexes them onto
// the tank underneath. Drawn from that alone, every one of them comes out as
// the plain tank it was made from, which is not what a player has ever seen.
//
// The client says so in two places at once and neither on its own is enough. The
// style carries `lockedOnVehicle`, which is what makes it permanent, and the
// group around it carries the vehicle filter naming who wears it.
import fs from "node:fs";
import path from "node:path";
import { decodePacked, type PackedNode } from "./packed.js";
import { child, text, words } from "./read.js";

/** A style the client has bolted onto one vehicle. */
export type LockedStyle = {
  /** The vehicle wearing it, by the code the scripts file it under. */
  code: string;
  /**
   * The set of models it swaps in, which is exactly the folder the mirror
   * publishes it under (`_skins/<models>`). Empty for the handful of locked
   * styles that are paint rather than models.
   */
  models: string;
};

/** Whether this style is one a vehicle can never take off. */
function isLocked(style: PackedNode): boolean {
  return words(child(style, "tags")).includes("lockedOnVehicle");
}

/**
 * Every style locked onto a vehicle, read from the client's customization tree.
 *
 * **The filter belongs to the group, not to the style**, which is the one thing
 * about these files that cannot be guessed from a style alone: a group holds a
 * `vehicleFilter` and the styles under it, so a reader that walks to every
 * `<style>` (as `readSkinNames` does, correctly for its own question) has
 * already lost the answer to this one.
 *
 * Deduplicated on the pair, since the catalogue restates a region's styles in a
 * `list.xml` beside the per-nation files, and a `_CN` or `_RU` variant of a file
 * carries the same style again for its own region.
 */
export function readLockedStyles(root: string): LockedStyle[] {
  const dir = path.join(root, "styles");
  if (!fs.existsSync(dir)) return [];
  const seen = new Set<string>();
  const out: LockedStyle[] = [];
  const walk = (node: PackedNode): void => {
    const filter = child(node, "vehicleFilter");
    if (filter) {
      const wearing = filter.children
        .filter((c) => c.name === "include")
        .flatMap((i) => words(child(i, "vehicles")))
        // `china:Ch25_121_mod_1971B_MK`, and the nation is the scripts' own
        // rather than the content folder's, so only the code travels.
        .map((v) => v.split(":").pop() ?? v);
      for (const style of node.children.filter((c) => c.name === "style")) {
        if (!isLocked(style)) continue;
        const models = text(child(style, "modelsSet"));
        for (const code of wearing) {
          const key = `${code}/${models}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ code, models });
        }
      }
    }
    for (const c of node.children) walk(c);
  };
  for (const file of fs.readdirSync(dir).sort()) {
    walk(decodePacked(fs.readFileSync(path.join(dir, file))));
  }
  return out;
}

/**
 * The model sets a run has to pull out of the client, given what it is for.
 *
 * A style that dresses a vehicle in paint alone names no set, so it is not one
 * of these: nothing has to be extracted for it, the vehicle's own geometry is
 * already the right shape.
 */
export function lockedModelSets(styles: LockedStyle[]): Set<string> {
  return new Set(styles.map((s) => s.models).filter(Boolean));
}
