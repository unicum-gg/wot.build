// What update 1.0 did to every map, measured across the stretch no client
// survives in.
//
// 1.0 rebuilt every map in HD, many with a new layout (Erlenberg's river,
// hills and town all moved), and no full client from 0.9.8 to 1.14 is kept
// anywhere reachable. The last client before it (0.9.7) and the first after it
// (1.15.0) are, so each map's package from both is reduced to a snapshot
// (`map-snapshot.ts` reads the older `.cdata`/`.chunk` layout too) and compared
// like any later update: where the ground moved, what was built or pulled
// down, and the minimap before and after. The change is filed under 1.0.0, the
// update that did nearly all of it, and carries `through` so the history says
// it was measured up to 1.15.0 rather than claiming 1.0 alone.
//
// Kept, with the old clients' own minimap redraws, in `<cache>/visuals.json`
// and merged into `history/index.json` whenever either is written, since
// `minimap-history.ts` rebuilds that index whole.
import fs from "node:fs";
import path from "node:path";
import { compareVersions } from "./archived-clients.js";
import { boundsAt } from "./map-bounds.js";
import { diffMap } from "./map-diff.js";
import { readSnapshot } from "./map-snapshot.js";
import type { VisualChange } from "./visual-history.js";

export const REWORK = { version: "1.0.0", from: "0.9.7", through: "1.15.0" };

const archivedFile = (out: string) => path.join(out, ".legacy-cache", "visuals.json");
export const snapshotFile = (cache: string, id: string, version: string) =>
  path.join(cache, id, `${version}.snapshot.json.gz`);

/** Put the changes read from the full clients into the visual index,
 * replacing any earlier entry for the same map and version. */
export function mergeRework(out: string): void {
  const file = archivedFile(out);
  if (!fs.existsSync(file)) return;
  const archived = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, VisualChange[]>;
  const indexFile = path.join(out, "history", "index.json");
  const index = fs.existsSync(indexFile)
    ? (JSON.parse(fs.readFileSync(indexFile, "utf8")) as Record<string, VisualChange[]>)
    : {};
  for (const [id, changes] of Object.entries(archived)) {
    const versions = new Set(changes.map((c) => c.version));
    const kept = (index[id] ?? []).filter((c) => !versions.has(c.version));
    index[id] = [...kept, ...changes].sort((a, b) => compareVersions(a.version, b.version));
  }
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
}

/** Each redraw the old clients' minimaps show (`legacy-minimaps.ts` keeps one
 * image per redraw), as a change with the image before and after: nothing
 * else of those packages is compared yet, so terrain and objects stay unsaid. */
function legacyRedraws(
  legacy: Record<string, { version: string; through: string }[]>,
): Record<string, VisualChange[]> {
  const out: Record<string, VisualChange[]> = {};
  for (const [id, images] of Object.entries(legacy)) {
    const old = images.filter((m) => compareVersions(m.version, REWORK.from) <= 0);
    for (let i = 1; i < old.length; i++) {
      (out[id] ??= []).push({
        version: old[i].version,
        from: old[i - 1].version,
        bytes: 0,
        hdBytes: 0,
        replaced: false,
        minimap: {
          before: `history/${id}/${old[i - 1].version}.webp`,
          after: `history/${id}/${old[i].version}.webp`,
        },
        relief: null,
        objects: null,
        aspects: [],
      });
    }
  }
  return out;
}

/**
 * Compare every map both clients carry. `legacy` is the published minimap
 * index, which names the image a map had at 0.9.7 (the newest kept at or below
 * it) and holds its 1.15.0 image.
 */
export async function buildReworkHistory(
  out: string,
  cache: string,
  legacy: Record<string, { version: string; through: string }[]>,
  log: (msg: string) => void,
): Promise<void> {
  const entries: Record<string, VisualChange[]> = legacyRedraws(legacy);
  for (const [id, images] of Object.entries(legacy)) {
    const before = snapshotFile(cache, id, REWORK.from);
    const after = snapshotFile(cache, id, REWORK.through);
    const oldImage = images.findLast((m) => compareVersions(m.version, REWORK.from) <= 0);
    const newImage = images.find((m) => m.version === REWORK.through);
    const bounds = await boundsAt(id, REWORK.through);
    if (!fs.existsSync(before) || !fs.existsSync(after) || !oldImage || !newImage || !bounds) continue;
    const dir = path.join(out, "history", id);
    fs.mkdirSync(dir, { recursive: true });
    const reliefFile = path.join(dir, `${REWORK.version}-relief.webp`);
    const objectsFile = path.join(dir, `${REWORK.version}-objects.webp`);
    const diff = await diffMap(readSnapshot(before), readSnapshot(after), bounds, reliefFile, objectsFile);
    const base = `history/${id}/${newImage.version}.webp`;
    (entries[id] ??= []).push({
      version: REWORK.version,
      from: REWORK.from,
      through: REWORK.through,
      bytes: 0,
      hdBytes: 0,
      replaced: false,
      // Every map was redrawn for HD, so the two pictures always differ.
      minimap: { before: `history/${id}/${oldImage.version}.webp`, after: base },
      relief: diff.relief
        ? { ...diff.relief, base, overlay: fs.existsSync(reliefFile) ? `history/${id}/${REWORK.version}-relief.webp` : null }
        : null,
      objects: diff.objects
        ? { ...diff.objects, base, overlay: fs.existsSync(objectsFile) ? `history/${id}/${REWORK.version}-objects.webp` : null }
        : null,
      aspects: [],
    });
    log(
      `  ${id} ${REWORK.from}->${REWORK.through}: relief ${diff.relief ? (diff.relief.rebuilt ? "rebuilt" : `+${diff.relief.rise}/-${diff.relief.drop} m`) : "-"}, objects ${diff.objects ? (diff.objects.rebuilt ? "rebuilt" : "changed") : "-"}`,
    );
  }
  fs.writeFileSync(archivedFile(out), `${JSON.stringify(entries, null, 1)}\n`);
  fs.rmSync(path.join(out, ".legacy-cache", "rework.json"), { force: true });
  mergeRework(out);
  const all = Object.values(entries).flat();
  const rework = all.filter((c) => c.version === REWORK.version).length;
  log(`rework ${REWORK.version}: ${rework} maps compared ${REWORK.from} -> ${REWORK.through}; ${all.length - rework} old minimap redraws`);
}
