/**
 * A package at the client's live version, rather than at the full install's.
 *
 * WGUS hands out a chain per part: one full install, then an incremental patch
 * per build published since. A generator that opens only the first link reads
 * the game as it was when that install was cut, which can be months of builds
 * ago, and nothing says so -- the version name it stamps comes from the chain's
 * end, so the mirror looks current while its contents are not.
 *
 * `generate-sources.ts` has resolved this from the start. This is that code,
 * lifted out so the other generators can use it too, and narrowed to what they
 * need: packages only, no loose root files.
 *
 * A patch carries two kinds of entry for a package:
 *
 *   res/packages/<name>.pkg.<build>.<crc>.rdiff   a delta against the previous
 *   res/packages/<name>.pkg                       the whole package, replaced
 *
 * so a package is rebuilt by extracting the full install's copy and replaying
 * its deltas in order, unless a patch republished it whole, in which case that
 * copy is the base and earlier deltas are dropped.
 */
import fs from "node:fs";
import path from "node:path";
import type { Block } from "./archive.js";
import { SparseArchive } from "./archive.js";
import { applyDelta, deltaTarget } from "./delta.js";
import type { Patch } from "./wgus.js";

/** Where a package's live bytes come from: a base copy plus deltas in order. */
export type Recipe = {
  base: { archive: SparseArchive; block: Block };
  deltas: string[];
};

export type Drained = {
  /** Package name -> its delta files, oldest first. */
  deltas: Map<string, string[]>;
  /** Package name -> where a patch published it whole. */
  added: Map<string, { archive: SparseArchive; block: Block }>;
};

/**
 * What the full install cannot give: every package delta the chain published,
 * and the packages a patch introduced or replaced outright.
 *
 * Each patch is opened, drained and released one at a time, so the sparse
 * volumes never all sit on disk together.
 */
export async function drainPatches(
  patches: Patch[],
  workDir: string,
  wanted: (name: string) => boolean,
  log: (message: string) => void = () => {},
): Promise<Drained> {
  const deltas = new Map<string, string[]>();
  const added = new Map<string, { archive: SparseArchive; block: Block }>();

  for (const [i, patch] of patches.entries()) {
    const dir = path.join(workDir, `patch-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = await SparseArchive.open(dir, patch.volumes);

    const pull = [...archive.index().values()].filter((block) => {
      const target = deltaTarget(block.name);
      return wanted(target ?? block.name);
    });

    let pulled = 0;
    for (const block of pull) {
      const target = deltaTarget(block.name);
      if (target) {
        const file = await archive.extract(block, path.join(workDir, "deltas", String(i)));
        deltas.set(target, [...(deltas.get(target) ?? []), file]);
        pulled++;
        continue;
      }
      // Published whole by this patch: read it back from here rather than from
      // the full install, and drop any delta collected for an older incarnation.
      added.set(block.name, { archive, block });
      deltas.delete(block.name);
    }
    log(`  patch ${patch.from} -> ${patch.to}: ${pull.length} package entries`);
    // A patch that only republished packages has nothing left on disk to punch
    // out, and the ones it did are read later, from this archive.
    if (added.size === 0) fs.rmSync(dir, { recursive: true, force: true });
    else if (pulled > 0) await archive.reset();
  }
  return { deltas, added };
}

/**
 * One recipe per package the caller wants, keyed by package name.
 *
 * `entries` is the full install's index. A package a patch republished whole is
 * taken from the patch instead, so the full install's stale copy is skipped.
 */
export function recipes(
  archive: SparseArchive,
  entries: Block[],
  wanted: (name: string) => boolean,
  drained: Drained,
): Map<string, Recipe> {
  const out = new Map<string, Recipe>();
  for (const block of entries) {
    if (!wanted(block.name) || drained.added.has(block.name)) continue;
    out.set(block.name, { base: { archive, block }, deltas: drained.deltas.get(block.name) ?? [] });
  }
  for (const [name, base] of drained.added) {
    if (!wanted(name)) continue;
    out.set(name, { base, deltas: drained.deltas.get(name) ?? [] });
  }
  return out;
}

/**
 * The package file at the live version, written under `unpackDir`.
 *
 * The caller owns `unpackDir` and should clear it between packages; it also
 * owns `recipe.base.archive`, whose blocks want punching out afterwards or the
 * sparse volumes grow into a full copy of the part.
 */
export async function rebuildPackage(recipe: Recipe, unpackDir: string): Promise<string> {
  let pkg = await recipe.base.archive.extract(recipe.base.block, unpackDir);
  for (const [i, delta] of recipe.deltas.entries()) {
    const next = path.join(unpackDir, `patched-${i}.pkg`);
    applyDelta(pkg, delta, next);
    fs.rmSync(pkg, { force: true });
    pkg = next;
  }
  return pkg;
}
