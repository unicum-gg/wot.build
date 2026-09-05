// Which vehicle a folder of geometry actually is.
//
// A content folder is named after a code and nothing else: `R45_IS-7` says
// neither the nation the scripts file it under, nor the tier, nor the tags that
// decide what a customization filter offers it. All of that lives in the
// nation's own index, one file per nation, and the only way from a code to the
// right index is to look.
import fs from "node:fs";
import path from "node:path";
import { decodePacked } from "./packed.js";
import { child, numbers } from "./read.js";

/** What a customization filter needs to know about a vehicle. */
export type VehicleIdentity = {
  /** The name the scripts use, `ussr`, which is not the content folder's. */
  nation: string;
  /** `ussr:R45_IS-7`, the way a filter names one vehicle. */
  key: string;
  level: number;
  tags: string[];
  /** How much the vehicle stretches a camouflage, from its own script. */
  density: [number, number];
};

/**
 * A vehicle's nation, tier and tags, out of its nation's own index.
 *
 * The scripts and the content name a nation differently, `ussr` against
 * `russian`, and nothing in a content path says which. Rather than carry a
 * table of the eleven pairs, this looks the code up in every nation's index and
 * takes the nation that has it, which is right by construction.
 */
export function readVehicleIdentity(
  dir: string,
  code: string,
): VehicleIdentity | null {
  if (!fs.existsSync(dir)) return null;
  for (const nation of fs.readdirSync(dir)) {
    const list = path.join(dir, nation, "list.xml");
    if (!fs.existsSync(list)) continue;
    const entry = child(decodePacked(fs.readFileSync(list)), code);
    if (!entry) continue;
    const own = path.join(dir, nation, `${code}.xml`);
    const camouflage = fs.existsSync(own)
      ? child(child(decodePacked(fs.readFileSync(own)), "camouflage"), "density")
      : undefined;
    const [dx = 1, dy = 1] = numbers(camouflage);
    return {
      nation,
      key: `${nation}:${code}`,
      level: Number(child(entry, "level")?.value ?? 0),
      tags: String(child(entry, "tags")?.value ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      density: [dx || 1, dy || 1],
    };
  }
  return null;
}
