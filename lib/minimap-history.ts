// The minimap of each version a map was reworked in, kept when the update
// redrew it.
//
// `visual-history.ts` says how much of a map's files an update rewrote; this
// says whether what a player sees from above moved, by reading the minimap out
// of that version's own install and comparing it with the one before. Only the
// updates whose delta crossed `VISUAL_CHANGE_BYTES` are read: a repack cannot
// have redrawn anything, and reading every map at every version would be the
// whole install forty times over.
//
// Every minimap extracted is cached under `<out>/.cache`, so a run that stops
// resumes where it was and a rerun after a threshold change costs nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { SparseArchive, type Block } from "./archive.js";
import { compareVersions } from "./archived-clients.js";
import { archivedInstalls, MAP_PARTS } from "./archived-installs.js";
import { decodeDDS } from "./dds.js";
import { boundsAt } from "./map-bounds.js";
import { diffMap } from "./map-diff.js";
import { mergeRework } from "./rework-history.js";
import { readSnapshot, snapshotPackage, writeSnapshot } from "./map-snapshot.js";
import {
  MINIMAP_REDRAWN,
  packageHistory,
  VISUAL_CHANGE_BYTES,
  type VisualChange,
} from "./visual-history.js";

export const SIGNATURE = 64;
// One connection to the Archive moves a block of 60 MB in about fifty seconds;
// split into ranges fetched side by side it is a few.
const RANGE = 4 << 20;
const PARALLEL = 16;

/** `archive.extract`, with the block fetched as parallel ranges first. */
export async function extractBlock(archive: SparseArchive, block: Block, destination: string): Promise<string> {
  const ranges: { start: number; length: number }[] = [];
  for (let at = 0; at < block.packed; at += RANGE) {
    ranges.push({ start: block.offset + at, length: Math.min(RANGE, block.packed - at) });
  }
  const queue = [...ranges];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) {
        const range = queue.shift()!;
        await archive.fill(range.start, range.length);
      }
    }),
  );
  execFileSync("7z", ["x", path.join(archive.dir, "a.7z.001"), `-i!${block.name}`, `-o${destination}`, "-y"], {
    stdio: "ignore",
  });
  return path.join(destination, block.name);
}

type Cached = { file: string; signature: number[] };

function cachePaths(out: string, id: string, version: string) {
  const dir = path.join(out, ".cache", id);
  return {
    dir,
    webp: path.join(dir, `${version}.webp`),
    sig: path.join(dir, `${version}.json`),
    snapshot: path.join(dir, `${version}.snapshot.json.gz`),
  };
}

const cached = (out: string, id: string, version: string) => {
  const paths = cachePaths(out, id, version);
  return fs.existsSync(paths.sig) && fs.existsSync(paths.snapshot);
};

/** The minimap of `id` at `version`, from cache or from the install, and the
 * package's snapshot (`map-snapshot.ts`) cached beside it. */
async function minimapAt(
  id: string,
  version: string,
  blocks: Map<string, { archive: SparseArchive; block: Block }>,
  out: string,
  size: number,
): Promise<Cached | null> {
  const paths = cachePaths(out, id, version);
  if (cached(out, id, version)) {
    return { file: paths.webp, signature: JSON.parse(fs.readFileSync(paths.sig, "utf8")) };
  }
  const found = blocks.get(id);
  if (!found) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-"));
  try {
    const pkg = await extractBlock(found.archive, found.block, work);
    fs.mkdirSync(paths.dir, { recursive: true });
    writeSnapshot(paths.snapshot, await snapshotPackage(pkg, id));
    execFileSync("7z", ["x", pkg, `-i!spaces/${id}/mmap.dds`, `-o${work}/dds`, "-y"], { stdio: "ignore" });
    const dds = path.join(work, "dds", "spaces", id, "mmap.dds");
    if (!fs.existsSync(dds)) return null;
    const { width, height, rgba } = decodeDDS(fs.readFileSync(dds));
    const raw = sharp(rgba, { raw: { width, height, channels: 4 } });
    fs.mkdirSync(paths.dir, { recursive: true });
    await raw.clone().resize(size, size, { kernel: "lanczos3" }).webp({ quality: 85 }).toFile(paths.webp);
    const grey = await raw
      .clone()
      .resize(SIGNATURE, SIGNATURE, { kernel: "cubic" })
      .greyscale()
      .raw()
      .toBuffer();
    const signature = [...grey];
    fs.writeFileSync(paths.sig, JSON.stringify(signature));
    return { file: paths.webp, signature };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Each pixel as standard deviations from its image's mean, so a change of
 * tone over the same drawing cancels out. */
function normalise(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length) || 1;
  return values.map((v) => (v - mean) / sd);
}

export function difference(a: number[], b: number[]): number {
  const na = normalise(a);
  const nb = normalise(b);
  let sum = 0;
  for (let i = 0; i < na.length; i++) sum += Math.abs(na[i] - nb[i]);
  return sum / na.length;
}

/**
 * Every visual change of every map in `arenas` across the archived installs,
 * with the minimap before and after where it was redrawn. Writes the published
 * images under `<out>/history/<id>/<version>.webp`.
 */
export async function buildVisualHistory(
  arenas: ReadonlySet<string>,
  out: string,
  log: (msg: string) => void,
  size = 1024,
): Promise<Record<string, VisualChange[]>> {
  const steps = await packageHistory(arenas, log);
  const installs = new Map((await archivedInstalls()).map((i) => [i.version, i]));

  // Which minimaps to read: for every map with a substantial change, the
  // version of the change and the one before it.
  const wanted = new Map<string, Set<string>>();
  const want = (version: string, id: string) => {
    if (!installs.has(version)) return;
    if (!wanted.has(version)) wanted.set(version, new Set());
    wanted.get(version)!.add(id);
  };
  for (const step of steps) {
    for (const [id, change] of step.maps) {
      if (change.bytes < VISUAL_CHANGE_BYTES && !change.replaced) continue;
      want(step.from, id);
      want(step.to, id);
    }
  }

  const minimaps = new Map<string, Cached>(); // `${id}@${version}`
  for (const version of [...wanted.keys()].sort(compareVersions)) {
    const ids = wanted.get(version)!;
    const missing = [...ids].filter((id) => !cached(out, id, version));
    const blocks = new Map<string, { archive: SparseArchive; block: Block }>();
    const dirs: string[] = [];
    try {
      if (missing.length > 0) {
        for (const part of MAP_PARTS) {
          const volume = installs.get(version)!.parts.get(part);
          if (!volume) continue;
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-"));
          dirs.push(dir);
          const archive = await SparseArchive.open(dir, [volume]);
          for (const [name, block] of archive.index()) {
            const m = /^res\/packages\/([^/]+)\.pkg$/.exec(name);
            if (m && missing.includes(m[1]) && !blocks.has(m[1])) blocks.set(m[1], { archive, block });
          }
        }
        log(`${version}: ${missing.length} minimaps to read`);
      }
      for (const id of ids) {
        try {
          const got = await minimapAt(id, version, blocks, out, size);
          if (got) minimaps.set(`${id}@${version}`, got);
        } catch (error) {
          log(`  ~ ${id}@${version}: ${(error as Error).message}`);
        }
      }
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const history: Record<string, VisualChange[]> = {};
  const historyDir = path.join(out, "history");
  fs.rmSync(historyDir, { recursive: true, force: true });
  const publish = (id: string, version: string): string => {
    const target = path.join(historyDir, id, `${version}.webp`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(minimaps.get(`${id}@${version}`)!.file, target);
    return `history/${id}/${version}.webp`;
  };
  // Where the ground moved and what was built or pulled down, drawn as
  // overlays on the newer minimap.
  const measure = async (id: string, from: string, to: string) => {
    const before = cachePaths(out, id, from).snapshot;
    const after = cachePaths(out, id, to).snapshot;
    const bounds = await boundsAt(id, to);
    if (!fs.existsSync(before) || !fs.existsSync(after) || !bounds || !minimaps.has(`${id}@${to}`)) {
      return { relief: null, objects: null, aspects: [] };
    }
    const dir = path.join(historyDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const reliefFile = path.join(dir, `${to}-relief.webp`);
    const objectsFile = path.join(dir, `${to}-objects.webp`);
    const diff = await diffMap(readSnapshot(before), readSnapshot(after), bounds, reliefFile, objectsFile);
    const base = diff.relief || diff.objects ? publish(id, to) : null;
    return {
      relief:
        diff.relief && base
          ? {
              ...diff.relief,
              base,
              overlay: fs.existsSync(reliefFile) ? `history/${id}/${to}-relief.webp` : null,
            }
          : null,
      objects:
        diff.objects && base
          ? {
              ...diff.objects,
              base,
              overlay: fs.existsSync(objectsFile) ? `history/${id}/${to}-objects.webp` : null,
            }
          : null,
      aspects: diff.aspects,
    };
  };
  for (const step of steps) {
    for (const [id, change] of step.maps) {
      const substantial = change.bytes + change.hdBytes >= VISUAL_CHANGE_BYTES || change.replaced;
      if (!substantial) continue;
      const before = minimaps.get(`${id}@${step.from}`);
      const after = minimaps.get(`${id}@${step.to}`);
      // A package republished whole with nothing to read before it is a map
      // arriving, which the history already records as such, not a rework.
      if (change.replaced && installs.has(step.from) && !before) continue;
      let minimap: VisualChange["minimap"] = null;
      if (before && after) {
        const diff = difference(before.signature, after.signature);
        if (diff >= MINIMAP_REDRAWN) {
          minimap = { before: publish(id, step.from), after: publish(id, step.to) };
        }
        log(`  ${id} ${step.from}->${step.to}: ${(change.bytes / 1e6).toFixed(1)} MB + ${(change.hdBytes / 1e6).toFixed(1)} MB HD, minimap ${diff.toFixed(3)}${minimap ? " redrawn" : ""}`);
      }
      const measured = await measure(id, step.from, step.to);
      log(`    relief ${measured.relief ? `+${measured.relief.rise}/-${measured.relief.drop} m over ${measured.relief.area} m2` : "-"}, objects ${measured.objects ? JSON.stringify([measured.objects.added, measured.objects.removed]) : "-"}, ${measured.aspects.join(" ") || "no other aspect"}`);
      (history[id] ??= []).push({ version: step.to, from: step.from, ...change, minimap, ...measured });
    }
  }
  fs.writeFileSync(path.join(historyDir, "index.json"), `${JSON.stringify(history, null, 2)}\n`);
  // The 1.0 rework is measured from the full clients, not the installs, and
  // would be lost every time this index is rebuilt.
  mergeRework(out);
  const redrawn = Object.values(history).flat().filter((c) => c.minimap).length;
  log(`visual history: ${Object.values(history).flat().length} changes over ${Object.keys(history).length} maps, ${redrawn} minimaps redrawn`);
  return history;
}
