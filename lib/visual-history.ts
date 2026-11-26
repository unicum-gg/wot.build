// How much of a map's own files each update rewrote.
//
// A map's arena definition says where its bases are and nothing about what it
// looks like: the terrain, the buildings and their textures live in its package,
// `res/packages/<id>.pkg`. Comparing that package's checksum across versions
// says nothing useful, it was measured: Wargaming republishes most map packages
// on most updates (78 of 78 at 2.4.0, 20 to 77 on the others since 1.20), so a
// changed checksum is the normal case rather than a change.
//
// The patches say more. An update ships as the binary delta of each package
// against the previous version, and a map package is a stored (uncompressed)
// zip, so the size of its delta follows the bytes that really changed inside
// it: a repack costs a few hundred kilobytes (Ruinberg, Mines, Abbey at 2.4.0:
// 0.14 to 0.29 MB) and a rework megabytes (Prokhorovka at 2.4.0: 6.4 MB). Those
// sizes are in the patch's 7z header, so the whole measure is one header per
// patch.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive } from "./archive.js";
import { compareVersions } from "./archived-clients.js";
import { fetchText } from "./http.js";
import type { MapAspect, ObjectsChange, ReliefChange } from "./map-diff.js";
import type { Volume } from "./wgus.js";

const ITEMS = ["world-of-tanks-wgc", "world-of-tanks-wgc-2"];

/** One update's patch of one part: the version it leads from and to. */
export type VersionPatch = { from: string; to: string; part: string; volume: Volume };

/** What one update did to one package. */
export type PackageChange = {
  /** Bytes of the delta: how much of the package was rewritten. For a package
   * the patch republished whole, its full size. */
  bytes: number;
  /** The patch shipped the package whole rather than as a delta. */
  replaced: boolean;
};

/** `wot_2.4.0.24013_2.3.1.23960_client.wgpkg`: a patch from one version to the
 * next. A patch between two builds of the same version is a hotfix, which the
 * history (keyed by three-part version) folds into its version. */
const PATCH = /^wot_(\d+\.\d+\.\d+)\.\d+_(\d+\.\d+\.\d+)\.\d+_([a-z]+)\.wgpkg$/;

export async function versionPatches(): Promise<VersionPatch[]> {
  const out: VersionPatch[] = [];
  for (const item of ITEMS) {
    const meta = JSON.parse(await fetchText(`https://archive.org/metadata/${item}/files`)) as {
      result: { name: string; size?: string }[];
    };
    for (const file of meta.result) {
      const [folder, name] = file.name.split("/");
      if (!name || folder === "locale") continue;
      const m = PATCH.exec(name);
      if (!m || m[1] === m[2]) continue;
      out.push({
        to: m[1],
        from: m[2],
        part: m[3],
        volume: {
          url: `https://archive.org/download/${item}/${file.name}`,
          size: Number(file.size ?? 0),
        },
      });
    }
  }
  return out.sort((a, b) => compareVersions(a.to, b.to));
}

/** Package id -> what the patch did to it, read from the patch's header alone. */
export async function patchChanges(patch: VersionPatch): Promise<Map<string, PackageChange>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-"));
  try {
    await SparseArchive.open(dir, [patch.volume]);
    const listing = execFileSync("7z", ["l", "-slt", path.join(dir, "a.7z.001")], {
      encoding: "utf8",
      maxBuffer: 256 << 20,
    });
    const out = new Map<string, PackageChange>();
    for (const entry of listing.split(/\r?\n\r?\n/)) {
      const name = (/^Path = (.+)$/m.exec(entry) ?? [])[1];
      const size = Number((/^Size = (\d+)$/m.exec(entry) ?? [])[1] ?? "NaN");
      if (!name || Number.isNaN(size)) continue;
      // `<id>.pkg.<build>.<crc>.rdiff` (or `.xdiff`) is a delta, `<id>.pkg` the
      // package republished whole.
      const m = /^res\/packages\/([^/]+?)\.pkg(?:\.[^/]*\.(?:rdiff|xdiff))?$/.exec(name);
      if (!m) continue;
      const replaced = name.endsWith(".pkg");
      const known = out.get(m[1]);
      // A hotfix chain can hold several deltas for one package; they add up.
      out.set(m[1], {
        bytes: (known?.bytes ?? 0) + size,
        replaced: (known?.replaced ?? false) || replaced,
      });
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What one update did to one map's look, as published. */
export type VisualChange = {
  version: string;
  from: string;
  /** Set when the change was measured across versions no client survives in
   * (the 1.0 rework): the newer client compared, which `version` is not. */
  through?: string;
  /** Bytes rewritten in the map's standard package (terrain, models, the
   * minimap). */
  bytes: number;
  /** Bytes rewritten in its HD package, which holds the high-resolution
   * textures. */
  hdBytes: number;
  /** A package was republished whole, so how much of it changed is unknown. */
  replaced: boolean;
  /** The minimap before and after, when the update redrew it: published paths
   * on the mirror branch. */
  minimap: { before: string; after: string } | null;
  /** Where the ground moved, drawn as `overlay` over `base` (the newer
   * minimap): red raised, blue lowered. */
  relief: (ReliefChange & { base: string; overlay: string | null }) | null;
  /** What was built or pulled down, drawn as `overlay` over `base`: green
   * added, red removed. No overlay when the objects were replaced wholesale. */
  objects: (ObjectsChange & { base: string; overlay: string | null }) | null;
  /** The other things the update touched in the map's files. */
  aspects: MapAspect[];
};

/** Below this a delta is a repack: measured at 2.4.0, the maps nobody touched
 * moved 0.14 to 0.35 MB, and the median delta over every update is 60 KB. */
export const VISUAL_CHANGE_BYTES = 1_000_000;

/**
 * Mean absolute difference between two minimaps shrunk to a 64-pixel grey
 * square, each normalised to its own brightness and contrast, above which the
 * minimap was redrawn. Measured by eye on the 1.19 to 2.4 pairs: a new tone over
 * the same drawing (Fjords at 2.0, Lakeville at 1.26) stays at or under 0.104
 * once normalised, while Himmelsdorf's redrawn square (0.117) and Mountain
 * Pass's new cover (0.162) clear it, and every full rework sits above 0.2. The
 * raw difference could not tell those apart: a tone shift moves every pixel a
 * little, which reads like a small redraw.
 */
export const MINIMAP_REDRAWN = 0.11;

/** Fold the HD package onto its map (`05_prohorovka_hd` -> `05_prohorovka`). */
export function mapOfPackage(id: string): { map: string; hd: boolean } {
  return id.endsWith("_hd") ? { map: id.slice(0, -3), hd: true } : { map: id, hd: false };
}

/** Every update's changes per map, oldest first, for the maps in `arenas`. */
export async function packageHistory(
  arenas: ReadonlySet<string>,
  log: (msg: string) => void,
): Promise<{ from: string; to: string; maps: Map<string, Omit<VisualChange, "minimap" | "version" | "from" | "relief" | "objects" | "aspects">> }[]> {
  const byStep = new Map<string, { from: string; to: string; maps: Map<string, Omit<VisualChange, "minimap" | "version" | "from" | "relief" | "objects" | "aspects">> }>();
  for (const patch of await versionPatches()) {
    const key = `${patch.from}->${patch.to}`;
    if (!byStep.has(key)) byStep.set(key, { from: patch.from, to: patch.to, maps: new Map() });
    const step = byStep.get(key)!;
    try {
      for (const [id, change] of await patchChanges(patch)) {
        const { map, hd } = mapOfPackage(id);
        if (!arenas.has(map)) continue;
        const entry = step.maps.get(map) ?? { bytes: 0, hdBytes: 0, replaced: false };
        if (hd) entry.hdBytes += change.bytes;
        else entry.bytes += change.bytes;
        entry.replaced ||= change.replaced;
        step.maps.set(map, entry);
      }
    } catch (error) {
      log(`  ~ ${key} ${patch.part}: ${(error as Error).message}`);
    }
  }
  return [...byStep.values()].sort((a, b) => compareVersions(a.to, b.to));
}
