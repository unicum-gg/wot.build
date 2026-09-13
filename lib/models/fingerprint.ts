// What the mirror was built from, package by package.
//
// **Wargaming publishes no patch to read.** Asked for the chain of a part, WGUS
// answers with one link: the whole install, 15.84 GB for the release branch's
// `sdcontent`. So a build says nothing about what changed inside it, and a run
// that trusts the version alone either does everything or nothing.
//
// The archive knows, though, and it says so in the header the sweep already
// downloads to enumerate its blocks: every package carries a checksum. Recorded
// beside the mirror, they turn the next build into a question about a few
// megabytes of header rather than five hours of conversion, and what is left to
// do is exactly the packages that moved.
import fs from "node:fs";
import path from "node:path";
import { SkinScope, type Settings } from "./settings.js";

/** The checksum each package had when the mirror was last written from it. */
export type Fingerprints = Record<string, string>;

/** What a run recorded: what it was asked to produce, and what it read. */
type Record_ = { settings: string; packages: Fingerprints };

const FILE = "packages.json";

/**
 * What this run produces, in one line, so a later one can tell whether the
 * mirror it is looking at was made the same way.
 *
 * **A checksum answers "did the client change", never "would we write something
 * different from it".** Ask for every 3D style where the last run took only the
 * locked ones and nothing in the client has moved: every package matches, every
 * package is skipped, and the styles are never extracted at all. Same for a
 * texture cap, and same for a collision-only run, whose output is a fraction of
 * a normal one. So the demand is recorded beside the checksums and a change to
 * it retires them.
 *
 * The generator changing under a demand that reads the same is what `--force`
 * is for: no line here can see that.
 */
export function demand(settings: Settings): string {
  return [
    `skins=${settings.skins === SkinScope.All ? "all" : "locked"}`,
    `hd=${settings.skipHd ? "off" : "on"}`,
    `collision=${settings.collisionOnly ? "only" : "no"}`,
    `sd=${settings.textureSize ?? "source"}`,
    `hdsize=${settings.hdTextureSize ?? "source"}`,
  ].join(" ");
}

/**
 * What the mirror holds, or nothing where it has never recorded it.
 *
 * Nothing is the honest answer for a mirror written before this existed, and it
 * reads as "every package has changed", so the first run after it fills the
 * record by doing exactly what it used to do.
 */
export function readFingerprints(out: string, asked: string): Fingerprints {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(out, FILE), "utf8")) as Record_;
    // A record written by a run that was asked for something else says nothing
    // about what this one has to do. So does one in a shape this version does
    // not know, which is how the first run after this file changed behaves.
    if (!held || held.settings !== asked || typeof held.packages !== "object") return {};
    return held.packages;
  } catch {
    return {};
  }
}

/**
 * Record what this run was built from.
 *
 * **Every package the client ships, not only the ones this run swept.** A
 * package skipped as unchanged is still what the mirror holds, and leaving it
 * out would make the next run sweep it for nothing, every time, forever.
 */
export function writeFingerprints(out: string, asked: string, prints: Fingerprints): void {
  fs.mkdirSync(out, { recursive: true });
  const record: Record_ = {
    settings: asked,
    packages: Object.fromEntries(Object.entries(prints).sort()),
  };
  fs.writeFileSync(path.join(out, FILE), `${JSON.stringify(record, null, 1)}\n`);
}

/**
 * The family a package belongs to, which is the grain a sweep can skip at.
 *
 * **Not the package.** A vehicle's pieces are split across its tier's `-partN`
 * packages, so a hull can sit in part 1 and its turret in part 2. Skipping one
 * part because it did not change, while sweeping the other because it did,
 * would rebuild that vehicle out of half of itself and publish the result over
 * a manifest that was whole. So the parts stand or fall together: one of them
 * moving is the tier moving.
 */
export function family(name: string): string {
  return name.replace(/-part\d+(?=\.pkg$)/, "");
}

/**
 * Which families a run has to sweep, given what the mirror was built from.
 *
 * A package with no recorded checksum, or one whose checksum the archive does
 * not give, counts as changed: the only state that lets a run skip work is a
 * match between two things that were both actually read.
 */
export function movedFamilies(
  prints: Fingerprints,
  blocks: Iterable<{ name: string; crc: string }>,
): Set<string> {
  const moved = new Set<string>();
  for (const { name, crc } of blocks) {
    if (!crc || prints[name] !== crc) moved.add(family(name));
  }
  return moved;
}
