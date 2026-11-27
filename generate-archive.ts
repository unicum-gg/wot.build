// Generator for the game's past: every map it has ever shipped, as it was.
//
// The live mirrors describe the client as it is today, and the update CDN only
// ever serves today's build, so a map Wargaming pulled is gone from both. This
// rebuilds the versions before our own mirror began (1.13, July 2021) from the
// two places they survive, and publishes them the way the live mirrors are
// published, so that what reads a version from `wot.src` reads these unchanged:
//
//   - the full EU clients preserved on the Internet Archive, 0.6.2 to 0.9.7,
//     which are Wargaming's own files: arena definitions, the localization that
//     names the maps, and the map packages their minimaps are in;
//   - a community mirror of the decompiled client for 0.9.12 to 1.12.1, which
//     carries the arena definitions and nothing else.
//
// Two outputs, two stages:
//
//   --versions DIR   one folder per version holding `sources/res/scripts/
//                    arena_defs/*.xml` and, where the source has one,
//                    `sources/res/text/lc_messages/arenas.po`, plus
//                    `versions.json`. Published as the `ARCHIVE` branch of
//                    `wot.src`, one commit per version.
//   --minimaps DIR   the catalogue of retired maps: `maps/<id>.webp` for every
//                    arena the live minimap mirror does not carry, cut from the
//                    last archived client that shipped its package, plus each
//                    retired arena's last definition (`arena_defs/<id>.xml`)
//                    and `index.json` (name, first and last version, which
//                    branch draws it). Published as the `ARCHIVE` branch of
//                    `wot.maps`.
//
// Both are resumable: a version or a minimap already written is skipped. The
// past does not change, so this is run once and then only to fill a gap.
//
// Usage: npm run archive -- --versions DIR [--minimaps DIR] [--size 2048]
//        npm run archive -- --minimaps DIR --legacy-minimaps
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archivedClients,
  compareVersions,
  extractFromClient,
  listClient,
  type ArchivedClient,
} from "./lib/archived-clients.js";
import { retiredArenas, timeline, writeCatalog } from "./lib/archive-catalog.js";
import { buildLegacyMinimaps } from "./lib/legacy-minimaps.js";
import { buildVisualHistory } from "./lib/minimap-history.js";
import { SparseArchive } from "./lib/archive.js";
import { archivedInstalls, archivedPatches, MAP_PARTS } from "./lib/archived-installs.js";
import { decodeDDS } from "./lib/dds.js";
import { decompiledArenaDefs, decompiledVersions } from "./lib/decompiled-mirror.js";
import { decodePacked, isPacked } from "./lib/packed.js";
import { archivedWikiMonths, releaseMonths } from "./lib/release-dates.js";
import { toXml } from "./lib/serialize.js";
import sharp from "sharp";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const VERSIONS = flag("--versions") ? path.resolve(flag("--versions")!) : null;
const MINIMAPS = flag("--minimaps") ? path.resolve(flag("--minimaps")!) : null;
const SIZE = Number(flag("--size") ?? "2048");
// The visual history alone: how much of each map's files every update since
// 1.19 rewrote, and the minimaps it redrew. Skips the catalogue's own minimap
// sweep, which a run of this does not change.
const VISUALS_ONLY = args.includes("--visuals-only");
// The minimaps of the archived clients (0.6.2 to 0.9.7), for the history's
// oldest updates: every map package of every client, kept where it was redrawn.
// Needs `--minimaps` only, and streams each client whole (see
// `lib/legacy-minimaps.ts`).
const LEGACY_MINIMAPS = args.includes("--legacy-minimaps");
const PYTHON = process.env.WOTSRC_PYTHON ?? "python3";
// Our own mirror starts here, so the archive stops just before it.
const MIRROR_START = "1.13.0";

const log = (msg: string) => console.log(`[archive] ${msg}`);

const DEFS_DIR = "sources/res/scripts/arena_defs";
const PO_FILE = "sources/res/text/lc_messages/arenas.po";

export type ArchivedVersion = {
  version: string;
  /** First day of the month the update shipped, or the client's own file date
   * when the publisher's history does not reach back that far. Null when
   * neither can be trusted. */
  date: string | null;
  source: "client" | "decompiled";
  /** The client build, for the archived clients. */
  build?: number;
  arenas: string[];
};

/** `arena_defs` text: a packed definition is decoded, a text one kept. */
function definitionText(buf: Buffer): string {
  return isPacked(buf) ? toXml(decodePacked(buf)) : buf.toString("utf8");
}

/** The `.po` text of one `.mo`, through the same converter `wot.src` uses. */
function poOf(mo: string): string {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), "mo-"));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "po-"));
  try {
    fs.copyFileSync(mo, path.join(from, "arenas.mo"));
    execFileSync(PYTHON, [path.resolve(import.meta.dirname, "lib/py/mo_to_po.py"), from, to], {
      stdio: "ignore",
    });
    return fs.readFileSync(path.join(to, "arenas.po"), "utf8");
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
}

/** Write one version's tree, returning the arenas it defines. */
function writeVersion(dir: string, defs: Map<string, string>, po: string | null): string[] {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, DEFS_DIR), { recursive: true });
  for (const [id, xml] of [...defs].sort(([a], [b]) => a.localeCompare(b))) {
    fs.writeFileSync(path.join(dir, DEFS_DIR, `${id}.xml`), xml);
  }
  if (po !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, PO_FILE)), { recursive: true });
    fs.writeFileSync(path.join(dir, PO_FILE), po);
  }
  return [...defs.keys()].sort();
}

/**
 * A client's own date, when nothing dates its version: the newest arena
 * definition it ships, as its archive stamps it. Only kept when it falls before
 * the next dated version, because some uploads were repacked from an installed
 * client years later and every file reads that day (0.7.0's say March 2019).
 * Without a plausible date the version carries none rather than a wrong one.
 */
function plausibleStamp(
  client: ArchivedClient,
  clients: ArchivedClient[],
  months: Map<string, string>,
): string | null {
  const stamp = clientDate(client);
  if (!stamp) return null;
  const later = clients
    .filter((c) => compareVersions(c.version, client.version) > 0)
    .map((c) => months.get(c.version))
    .find((d): d is string => d !== undefined);
  // Strictly before, even though the later date is only a month: the versions
  // are ordered by these dates, so a stamp inside the next version's month
  // (0.7.1's files read 2012-03-09, 0.7.2 is dated March 2012) would put the
  // two the wrong way round.
  return later === undefined || stamp < later ? stamp : null;
}

/** The newest arena definition a client ships, as its archive stamps it. */
function clientDate(client: ArchivedClient): string | null {
  const stamps = listClient(client)
    .filter((e) => /\/scripts\/arena_defs\/[^/]+\.xml$/.test(e.path) && e.modified)
    .map((e) => e.modified!.slice(0, 10))
    .sort();
  return stamps.at(-1) ?? null;
}

async function buildVersions(out: string): Promise<ArchivedVersion[]> {
  fs.mkdirSync(out, { recursive: true });
  const manifestPath = path.join(out, "versions.json");
  const known: ArchivedVersion[] = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : [];
  const done = new Map(known.map((v) => [v.version, v]));
  // The publisher's page first, its archived wiki for the years before it.
  const months = await archivedWikiMonths();
  for (const [version, date] of await releaseMonths()) months.set(version, date);
  const save = () =>
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify([...done.values()].sort((a, b) => compareVersions(a.version, b.version)), null, 2)}\n`,
    );

  const clients = await archivedClients();
  log(`${clients.length} archived clients: ${clients.map((c) => c.version).join(", ")}`);
  for (const client of clients) {
    if (done.has(client.version)) continue;
    log(`${client.version} (#${client.build})`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "client-"));
    try {
      await extractFromClient(
        client,
        work,
        "res/scripts/arena_defs/[^/]+\\.xml$|res/text/(?i:lc_messages)/arenas\\.mo$",
        log,
      );
      // Every client nests its tree under a folder of its own name.
      const roots = fs.readdirSync(work).map((d) => path.join(work, d));
      const root = roots.find((r) => fs.existsSync(path.join(r, "res"))) ?? work;
      const defsDir = path.join(root, "res/scripts/arena_defs");
      const defs = new Map<string, string>();
      for (const file of fs.existsSync(defsDir) ? fs.readdirSync(defsDir) : []) {
        if (!file.endsWith(".xml")) continue;
        defs.set(file.slice(0, -4), definitionText(fs.readFileSync(path.join(defsDir, file))));
      }
      const textDir = path.join(root, "res/text");
      const lc = fs.existsSync(textDir)
        ? fs.readdirSync(textDir).find((d) => d.toLowerCase() === "lc_messages")
        : undefined;
      const mo = lc ? path.join(textDir, lc, "arenas.mo") : null;
      const po = mo && fs.existsSync(mo) ? poOf(mo) : null;
      const arenas = writeVersion(path.join(out, client.version), defs, po);
      const date = months.get(client.version) ?? plausibleStamp(client, clients, months);
      done.set(client.version, {
        version: client.version,
        date,
        source: "client",
        build: client.build,
        arenas,
      });
      save();
      log(`  ${arenas.length} arenas${po ? ", names" : ""}, ${date}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // Dates are re-read on every run rather than trusted from the manifest, so a
  // better source (or a stricter rule) reaches the versions already written.
  for (const client of clients) {
    const entry = done.get(client.version);
    if (!entry) continue;
    entry.date = months.get(client.version) ?? plausibleStamp(client, clients, months);
  }
  save();

  const lastClient = clients[clients.length - 1]?.version ?? "0.0.0";
  for (const { version, branch } of await decompiledVersions(lastClient, MIRROR_START)) {
    const known = done.get(version);
    if (known) {
      known.date = months.get(version) ?? null;
      continue;
    }
    const defs = await decompiledArenaDefs(branch);
    if (defs.size === 0) {
      log(`${version}: no arena definitions on the decompiled mirror, skipped`);
      continue;
    }
    const arenas = writeVersion(path.join(out, version), defs, null);
    done.set(version, {
      version,
      date: months.get(version) ?? null,
      source: "decompiled",
      arenas,
    });
    save();
    log(`${version}: ${arenas.length} arenas (decompiled), ${months.get(version) ?? "no date"}`);
  }
  return [...done.values()].sort((a, b) => compareVersions(a.version, b.version));
}

/** The arena ids a branch of the live minimap mirror carries. */
async function liveMinimaps(branches = ["WG", "WG_CT"]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const branch of branches) {
    const res = await fetch(
      `https://api.github.com/repos/unicum-gg/wot.maps/git/trees/${branch}?recursive=1`,
      { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} },
    );
    const tree = (await res.json()) as { tree: { path: string }[] };
    for (const { path: p } of tree.tree) {
      const m = /^maps\/(.+)\.webp$/.exec(p);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/**
 * A minimap for every retired arena the live mirror does not carry.
 *
 * Two archives, newest first within each, since an arena's minimap is taken
 * from the last build that shipped its package, which is the map as it was when
 * it left: the update CDN's own installs preserved since 1.19.1, then the
 * patches uploaded beside them (where an event map lives, added partway through
 * a version and pulled before the next), then the full clients of 0.6.2 to
 * 0.9.7. What none carries (the maps that lived only between 0.9.8 and 1.18)
 * is reported and keeps no image.
 */
async function buildMinimaps(retired: Iterable<string>, live: ReadonlySet<string>, out: string) {
  const mapsDir = path.join(out, "maps");
  fs.mkdirSync(mapsDir, { recursive: true });
  const missing = new Set(
    [...retired].filter((id) => !live.has(id) && !fs.existsSync(path.join(mapsDir, `${id}.webp`))),
  );
  log(`${missing.size} retired arenas without a minimap yet`);

  for (const install of await archivedInstalls()) {
    if (missing.size === 0) break;
    for (const part of MAP_PARTS) {
      const volume = install.parts.get(part);
      if (!volume || missing.size === 0) continue;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-"));
      try {
        const archive = await SparseArchive.open(dir, [volume]);
        const blocks = archive.index();
        for (const id of [...missing]) {
          const block = blocks.get(`res/packages/${id}.pkg`);
          if (!block) continue;
          log(`${install.version} ${part}: ${id}`);
          const pkg = await archive.extract(block, path.join(dir, "pkg"));
          try {
            await minimapFromPackage(pkg, id, path.join(mapsDir, `${id}.webp`));
            missing.delete(id);
          } catch (error) {
            log(`  ~ ${id}: ${(error as Error).message}`);
          }
          fs.rmSync(path.join(dir, "pkg"), { recursive: true, force: true });
          await archive.reset();
        }
      } catch (error) {
        log(`  ~ ${install.version} ${part}: ${(error as Error).message}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // The event maps live in no full install, only in the patch that added them.
  for (const patch of await archivedPatches()) {
    if (missing.size === 0) break;
    if (!MAP_PARTS.includes(patch.part)) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-"));
    try {
      const archive = await SparseArchive.open(dir, [patch.volume]);
      const blocks = archive.index();
      for (const id of [...missing]) {
        const block = blocks.get(`res/packages/${id}.pkg`);
        if (!block) continue;
        log(`${patch.version} patch ${patch.part}: ${id}`);
        const pkg = await archive.extract(block, path.join(dir, "pkg"));
        try {
          await minimapFromPackage(pkg, id, path.join(mapsDir, `${id}.webp`));
          missing.delete(id);
        } catch (error) {
          log(`  ~ ${id}: ${(error as Error).message}`);
        }
        fs.rmSync(path.join(dir, "pkg"), { recursive: true, force: true });
        await archive.reset();
      }
    } catch (error) {
      log(`  ~ ${patch.version} patch ${patch.part}: ${(error as Error).message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const clients = (await archivedClients()).reverse();
  for (const client of clients) {
    if (missing.size === 0) break;
    const entries = listClient(client);
    const here = [...missing].filter((id) =>
      // Some uploads nest the tree under a folder named after the client,
      // others put `res/` at the root.
      entries.some((e) => e.path === `res/packages/${id}.pkg` || e.path.endsWith(`/res/packages/${id}.pkg`)),
    );
    if (here.length === 0) continue;
    log(`${client.version}: ${here.length} minimaps (${here.join(", ")})`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "pkgs-"));
    try {
      const pattern = `(?:^|/)res/packages/(${here.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.pkg$`;
      await extractFromClient(client, work, pattern, log);
      for (const id of here) {
        const pkg = findFile(work, `${id}.pkg`);
        if (!pkg) continue;
        try {
          await minimapFromPackage(pkg, id, path.join(mapsDir, `${id}.webp`));
          missing.delete(id);
        } catch (error) {
          log(`  ~ ${id}: ${(error as Error).message}`);
        }
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  if (missing.size) log(`no archive carries a minimap for: ${[...missing].sort().join(", ")}`);
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return null;
}

/** `spaces/<id>/mmap.dds` out of a map package, as a square WebP. */
async function minimapFromPackage(pkg: string, id: string, outFile: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-"));
  try {
    execFileSync("7z", ["x", pkg, `-i!spaces/${id}/mmap.dds`, `-o${dir}`, "-y"], { stdio: "ignore" });
    const dds = path.join(dir, "spaces", id, "mmap.dds");
    if (!fs.existsSync(dds)) throw new Error("no mmap.dds in the package");
    const { width, height, rgba } = decodeDDS(fs.readFileSync(dds));
    let img = sharp(rgba, { raw: { width, height, channels: 4 } });
    if (SIZE !== width) img = img.resize(SIZE, SIZE, { kernel: "lanczos3" });
    await img.webp({ quality: 88 }).toFile(outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (LEGACY_MINIMAPS) {
    if (!MINIMAPS) throw new Error("--legacy-minimaps needs --minimaps DIR");
    await buildLegacyMinimaps(MINIMAPS, path.join(MINIMAPS, ".legacy-cache"), SIZE, log);
    return;
  }
  if (!VERSIONS) throw new Error("--versions DIR is required");
  const versions = await buildVersions(VERSIONS);
  log(`${versions.length} versions in ${VERSIONS}`);
  if (!MINIMAPS) return;
  const full = await timeline(VERSIONS, log);
  if (VISUALS_ONLY) {
    await buildVisualHistory(new Set(full.flatMap((v) => v.arenas)), MINIMAPS, log);
    return;
  }
  const retired = await retiredArenas(full);
  log(`${retired.size} retired battle arenas over ${full.length} versions`);
  await buildMinimaps(retired.keys(), await liveMinimaps(), MINIMAPS);
  await writeCatalog(full, retired, MINIMAPS, await liveMinimaps(["WG"]), log, (mo) => poOf(mo));
  await buildVisualHistory(new Set(full.flatMap((v) => v.arenas)), MINIMAPS, log);
  // The visual history rewrites `history/` whole, which takes the old clients'
  // minimaps and the 1.0 rework with it (a republish once dropped all of them).
  // Put them back from the cache they were measured into: no client is read
  // again unless its marker is missing.
  const legacyCache = path.join(MINIMAPS, ".legacy-cache");
  if (fs.existsSync(legacyCache)) await buildLegacyMinimaps(MINIMAPS, legacyCache, SIZE, log);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
