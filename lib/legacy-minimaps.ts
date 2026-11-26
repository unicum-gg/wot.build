// The minimap every map had in the clients the Internet Archive kept, 0.6.2 to
// 0.9.7, for the history's oldest updates.
//
// The history draws a version's moved markers over a minimap, and before the
// archived installs begin (1.19.1) it only had today's to draw them on: a 0.8
// spawn placed over the HD map of 1.0, on a map it never stood on. Those clients
// are whole installs, so every map package in them carries the minimap of its
// time. Each client is streamed once, every map package in it pulled out, and
// its minimap cached; a minimap is then published only where it was redrawn
// since the client before, by the same comparison `minimap-history.ts` applies
// to the later installs, so a map drawn once in 2012 and never again is one
// image rather than thirty.
//
// One later client survives too, a full 1.15.0 install, in the middle of the
// stretch (0.9.8 to 1.18) nothing else covers. Its minimaps are compared with
// the earliest one the installs since 1.19.1 hold: a map that did not change
// between the two is known for that whole interval, one that did only for 1.15.
//
// Writes `<out>/history/<id>/<version>.webp` for each image kept and
// `<out>/history/legacy-minimaps.json` ({ id: [{ version, through }] }, oldest
// first): the minimap at a version is the newest image at or below it, as long
// as the version is at or below that image's `through`. The cache lives under
// `<cache>/<id>/<version>.{webp,json}`, with a `<cache>/.done/<version>` marker
// per client, so a run that stops resumes at the client it was reading.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { archivedClients, compareVersions, extractFromClient, listClient } from "./archived-clients.js";
import { decodeDDS } from "./dds.js";
import { difference, SIGNATURE } from "./minimap-history.js";
import { fetchRange } from "./http.js";
import { MINIMAP_REDRAWN } from "./visual-history.js";
import { snapshotPackage, writeSnapshot } from "./map-snapshot.js";
import { buildReworkHistory, REWORK, snapshotFile } from "./rework-history.js";

/** A map package, named by its space: `res/packages/04_himmelsdorf.pkg`. The
 * other packages of a client (`gui`, `vehicles_*`, `shared_content`) are not
 * spaces, and every space id starts with its number. The `_hd` half of a 1.x
 * map holds its high-resolution textures and no minimap, and at a few hundred
 * megabytes a map would only fill the disk. */
const MAP_PACKAGE = /(?:^|\/)res\/packages\/(\d[^/]*?)(?<!_hd)\.pkg$/;

/** The last of the clients of 0.6.2 to 0.9.7: their images hold until it. */
const OLD_CLIENTS_END = "0.9.7";

/** Full installs kept outside the two archive.org items `archivedClients`
 * reads, each one its own item. */
const LATER_CLIENTS = [
  {
    version: "1.15.0",
    build: 1129,
    url: "https://archive.org/download/world-of-tanks-1.15.0.0-b1129-hd/World_of_Tanks_1.15.0.0_%231129_HD.7z",
  },
];

/** The first update the archived installs (and so the history's own minimap
 * rows) cover. */
const INSTALLS_START = "1.19.1";

/** Every 1.15.x: a patch inside a minor version is not where a map is redrawn. */
const throughMinor = (version: string) => `${version.split(".").slice(0, 2).join(".")}.99`;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Cache one package's minimap: the published size, and its signature. */
async function cacheMinimap(pkg: string, id: string, file: string, sig: string, size: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-"));
  try {
    execFileSync("7z", ["x", pkg, `-i!spaces/${id}/mmap.dds`, `-o${dir}`, "-y"], { stdio: "ignore" });
    const dds = path.join(dir, "spaces", id, "mmap.dds");
    if (!fs.existsSync(dds)) return false;
    const { width, height, rgba } = decodeDDS(fs.readFileSync(dds));
    const raw = sharp(rgba, { raw: { width, height, channels: 4 } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await raw.clone().resize(size, size, { kernel: "lanczos3" }).webp({ quality: 85 }).toFile(file);
    const grey = await raw.clone().resize(SIGNATURE, SIGNATURE, { kernel: "cubic" }).greyscale().raw().toBuffer();
    fs.writeFileSync(sig, JSON.stringify([...grey]));
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildLegacyMinimaps(
  out: string,
  cache: string,
  size: number,
  log: (msg: string) => void,
): Promise<void> {
  const doneDir = path.join(cache, ".done");
  fs.mkdirSync(doneDir, { recursive: true });
  const clients = [...(await archivedClients()), ...LATER_CLIENTS];

  for (const client of clients) {
    if (fs.existsSync(path.join(doneDir, client.version))) continue;
    const ids = [
      ...new Set(listClient(client).flatMap((e) => MAP_PACKAGE.exec(e.path)?.[1] ?? [])),
    ];
    log(`${client.version}: ${ids.length} map packages`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
    try {
      await extractFromClient(client, work, MAP_PACKAGE.source, log);
      for (const pkg of walk(work)) {
        const id = MAP_PACKAGE.exec(pkg.replaceAll(path.sep, "/"))?.[1];
        if (!id) continue;
        const file = path.join(cache, id, `${client.version}.webp`);
        const sig = path.join(cache, id, `${client.version}.json`);
        try {
          if (!(await cacheMinimap(pkg, id, file, sig, size))) log(`  ~ ${id}: no mmap.dds`);
        } catch (error) {
          log(`  ~ ${id}: ${(error as Error).message}`);
        }
        // The two clients the 1.0 rework is measured between keep the whole
        // map, reduced to a snapshot (`rework-history.ts`).
        const snap = snapshotFile(cache, id, client.version);
        if ((client.version === REWORK.from || client.version === REWORK.through) && !fs.existsSync(snap)) {
          try {
            fs.mkdirSync(path.dirname(snap), { recursive: true });
            writeSnapshot(snap, await snapshotPackage(pkg, id));
          } catch (error) {
            log(`  ~ ${id} snapshot: ${(error as Error).message}`);
          }
        }
        fs.rmSync(pkg, { force: true });
      }
      fs.writeFileSync(path.join(doneDir, client.version), "");
    } catch (error) {
      log(`  ~ ${client.version}: ${(error as Error).message}`);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // Keep the redraws only: within the old clients, the first minimap of each
  // map, then each one that differs from the last kept by as much as a redraw
  // does, all of them good until the last old client. A later client's image is
  // always kept, and good until the installs begin when the earliest minimap
  // they hold is the same drawing.
  const index: Record<string, { version: string; through: string }[]> = {};
  const keep = (id: string, version: string, through: string) => {
    const target = path.join(out, "history", id, `${version}.webp`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(cache, id, `${version}.webp`), target);
    (index[id] ??= []).push({ version, through });
  };
  const maps = fs
    .readdirSync(cache, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  for (const id of maps) {
    const versions = fs
      .readdirSync(path.join(cache, id))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort(compareVersions);
    const read = (version: string) =>
      JSON.parse(fs.readFileSync(path.join(cache, id, `${version}.json`), "utf8")) as number[];
    let kept: number[] | null = null;
    for (const version of versions.filter((v) => compareVersions(v, OLD_CLIENTS_END) <= 0)) {
      const signature = read(version);
      if (kept && difference(kept, signature) < MINIMAP_REDRAWN) continue;
      kept = signature;
      keep(id, version, OLD_CLIENTS_END);
    }
    for (const version of versions.filter((v) => compareVersions(v, OLD_CLIENTS_END) > 0)) {
      const later = await installsSignature(out, id);
      const same = later !== null && difference(read(version), later) < MINIMAP_REDRAWN;
      keep(id, version, same ? INSTALLS_START : throughMinor(version));
    }
  }
  fs.writeFileSync(path.join(out, "history", "legacy-minimaps.json"), `${JSON.stringify(index, null, 1)}\n`);
  const images = Object.values(index).reduce((n, v) => n + v.length, 0);
  const bridged = Object.values(index).flat().filter((e) => e.through === INSTALLS_START).length;
  log(`later clients: ${bridged} minimaps unchanged up to ${INSTALLS_START}`);
  log(`legacy minimaps: ${images} images over ${Object.keys(index).length} maps`);
  await buildReworkHistory(out, cache, index, log);
}

/**
 * The signature of the earliest minimap the installs since 1.19.1 hold for a
 * map: the oldest one `minimap-history.ts` cached (it reads a map at every
 * rework, and a redraw only ever comes with one), or the live minimap when the
 * map was never reworked since. Null when neither can be read.
 */
async function installsSignature(out: string, id: string): Promise<number[] | null> {
  const dir = path.join(out, ".cache", id);
  if (fs.existsSync(dir)) {
    const oldest = fs
      .readdirSync(dir)
      .filter((f) => /^\d[\d.]*\.json$/.test(f))
      .map((f) => f.slice(0, -".json".length))
      .sort(compareVersions)[0];
    if (oldest) return JSON.parse(fs.readFileSync(path.join(dir, `${oldest}.json`), "utf8")) as number[];
  }
  try {
    const live = await fetchRange(`https://raw.githubusercontent.com/unicum-gg/wot.maps/WG/maps/${id}.webp`);
    const grey = await sharp(live).resize(SIGNATURE, SIGNATURE, { kernel: "cubic" }).greyscale().raw().toBuffer();
    return [...grey];
  } catch {
    return null;
  }
}
