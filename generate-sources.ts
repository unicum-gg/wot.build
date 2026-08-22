// Generator for the `unicum-gg/wot-src` mirror: rebuilds the decompiled World of
// Tanks client sources straight from Wargaming's update CDN, with no game
// client installed, and writes the same tree IzeBerg/wot-src publishes.
//
// Pipeline:
//   1. WGUS -> the versioned CDN URLs of the install `.wgpkg` volumes, full
//      install first and then every incremental patch published since.
//   2. Those volumes are a split 7-Zip; we rebuild them SPARSE, fill only the
//      header, and range-download one block per package we care about.
//   3. A package is rebuilt to the live version by applying the chain's binary
//      deltas, then harvested: it is a zip laid out under `sources/res/`. We
//      keep sources only, exactly as upstream does: `.pyc` decompiled to `.py`,
//      packed XML converted to text, `.def`/`.txt` copied, `.swc` decompiled
//      into `sources-as3/<library>/`, everything binary dropped.
//   4. The game root's own config files are harvested the same way.
//   5. The `locale` part's gettext `.mo` become `.po`.
//
// Usage: npm run generate -- --host H --guid G --out DIR [--force] [--only PKG]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive, type Block } from "./lib/archive.js";
import { applyDelta, deltaTarget } from "./lib/delta.js";
import { createHarvester, walk, writeFile } from "./lib/harvest.js";
import { resolveClient, type Patch } from "./lib/wgus.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const HOST = flag("--host") ?? "wgus-woteu.wargaming.net";
const GUID = flag("--guid") ?? "WOT.EU.PRODUCTION";
const OUT = path.resolve(flag("--out") ?? "out");
const ONLY = flag("--only"); // debug: a single package
const FORCE = args.includes("--force");

// Toolchain. These exact versions are what reproduce upstream byte for byte:
// a newer uncompyle6 mangles nested dict comprehensions, and ffdec past 14.4.0
// reorders SWF metadata and rewrites boolean coercions.
const PYTHON = process.env.WOTSRC_PYTHON ?? "python3";
const FFDEC_JAR = process.env.WOTSRC_FFDEC_JAR ?? "tools/ffdec/ffdec.jar";

// Packages live in two parts: `client` holds the scripts, the GUI and the mode
// packs, while `sdcontent` carries the bulk of the models (vehicles_level_08 and
// up, shared_content). Both are needed for a complete mirror.
const PACKAGE_PARTS = ["client", "sdcontent"];

// The audio banks are gigabytes of Wwise blobs and yield not one published
// file, so they are never downloaded and their deltas are never applied.
const SKIPPED_PACKAGE = /(^|\/)audioww/i;

const ROOT = path.join(OUT, "sources");
const SOURCES = path.join(ROOT, "res");
const SOURCES_AS3 = path.join(OUT, "sources-as3");

// Outside `res/packages` the volumes also carry the game root itself: the
// engine's config files, `version.xml`, the mod folder placeholders. Upstream
// publishes those, but none of the runtime that sits next to them.
//
// Unlike a package, whose every entry has to be read before its kind is known,
// the root is flat and small enough to name what we want: config and text. That
// keeps the fonts and the intro videos, a hundred megabytes of them, off the
// wire entirely rather than downloading them for the harvester to drop.
const LOOSE_PUBLISHED = /\.(xml|txt|def)$/i;
const LOOSE_EXCLUDED = /^(_service|win64|res\/cef)\//;
const isLooseSource = (name: string) =>
  LOOSE_PUBLISHED.test(name) && !LOOSE_EXCLUDED.test(name);

// Hand-written stubs for the engine's native modules (`BigWorld`, `Entity`,
// `WoT`...). They are not in any package: the client only ships them compiled
// into the executable, so an IDE resolving the decompiled scripts has nothing
// to point at. Vendored from upstream, which generated them by introspecting a
// running client, and published alongside the sources they annotate.
const STUBS = path.resolve("stubs");

const log = (msg: string) => console.log(`[wot-src] ${msg}`);

const { pycRoot, moRoot, harvest } = createHarvester({
  workDir: fs.mkdtempSync(path.join(os.tmpdir(), "wotsrc-")),
  sourcesAs3: SOURCES_AS3,
  ffdecJar: FFDEC_JAR,
  log,
});
const workDir = path.dirname(pycRoot);

const isPackage = (name: string) => /^res\/packages\/[^/]+\.pkg$/.test(name);
const wanted = (pkg: string) => !SKIPPED_PACKAGE.test(pkg) && (!ONLY || pkg.includes(ONLY));

/** Where a package comes from, and what has to be replayed on top of it. */
type Recipe = { base: { archive: SparseArchive; block: Block }; deltas: string[] };

/**
 * Pull from every incremental patch what the full install cannot give us: the
 * deltas, the packages a patch introduces whole, and the newer copies of the
 * game root's files.
 *
 * Each patch is opened, drained and released one at a time, so the sparse
 * volumes never all sit on disk together.
 */
async function drainPatches(
  patches: Patch[],
  loose: string,
): Promise<{ deltas: Map<string, string[]>; added: Map<string, { archive: SparseArchive; block: Block }> }> {
  const deltas = new Map<string, string[]>();
  const added = new Map<string, { archive: SparseArchive; block: Block }>();

  for (const [i, patch] of patches.entries()) {
    const dir = path.join(workDir, `patch-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = await SparseArchive.open(dir, patch.volumes);
    const entries = [...archive.index().values()];

    const pull = entries.filter((block) => {
      const target = deltaTarget(block.name);
      if (target) return wanted(target);
      if (isPackage(block.name)) return wanted(block.name);
      return isLooseSource(block.name) && block.packed > 0;
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
      if (isPackage(block.name)) {
        // Introduced whole by this patch: read it back from here, not from the
        // full install, and drop any delta collected for an older incarnation.
        added.set(block.name, { archive, block });
        deltas.delete(block.name);
        continue;
      }
      // Root files: later patches overwrite earlier ones, which is exactly the
      // state a patched install ends up in.
      await archive.extract(block, loose);
      pulled++;
    }
    log(`  patch ${patch.from} -> ${patch.to}: ${pull.length} entries`);
    // A patch that only introduces packages has nothing left on disk to punch
    // out, and the ones it does introduce are read later, from this archive.
    if (added.size === 0) fs.rmSync(dir, { recursive: true, force: true });
    else if (pulled > 0) await archive.reset();
  }
  return { deltas, added };
}

/** Rebuild one package at the live version and publish what it holds. */
async function harvestPackage(name: string, recipe: Recipe): Promise<void> {
  const unpackDir = path.join(workDir, "pkg");
  fs.rmSync(unpackDir, { recursive: true, force: true });
  let pkg = await recipe.base.archive.extract(recipe.base.block, unpackDir);

  for (const [i, delta] of recipe.deltas.entries()) {
    const next = path.join(unpackDir, `patched-${i}.pkg`);
    applyDelta(pkg, delta, next);
    fs.rmSync(pkg, { force: true });
    pkg = next;
  }

  const contents = path.join(workDir, "contents");
  fs.rmSync(contents, { recursive: true, force: true });
  execFileSync("7z", ["x", pkg, `-o${contents}`, "-y"], { stdio: "ignore" });
  const stats = harvest(contents, SOURCES);
  const patched = recipe.deltas.length > 0 ? `, +${recipe.deltas.length} patch` : "";
  log(
    `  ${path.basename(name)} (${(recipe.base.block.packed / 1e6).toFixed(0)} MB${patched}): ` +
      `${stats.xml} xml, ${stats.copied} copied, ${stats.swc} swc`,
  );
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.rmSync(contents, { recursive: true, force: true });
}

async function harvestPart(part: string, chain: Patch[], loose: string): Promise<void> {
  const [full, ...patches] = chain;
  log(`${part}: full install + ${patches.length} patches`);
  const { deltas, added } = await drainPatches(patches, loose);

  const partDir = path.join(workDir, part);
  fs.mkdirSync(partDir, { recursive: true });
  const archive = await SparseArchive.open(partDir, full.volumes);
  const entries = [...archive.index().values()];

  // Root files first: the full install's copies must not overwrite the patched
  // ones already pulled above.
  for (const block of entries) {
    if (!isLooseSource(block.name) || block.packed === 0) continue;
    const target = path.join(loose, block.name);
    if (!fs.existsSync(target)) await archive.extract(block, loose);
  }
  await archive.reset();

  const recipes = new Map<string, Recipe>();
  for (const block of entries) {
    if (!isPackage(block.name) || !wanted(block.name)) continue;
    if (added.has(block.name)) continue; // a patch republished it whole
    recipes.set(block.name, { base: { archive, block }, deltas: deltas.get(block.name) ?? [] });
  }
  for (const [name, base] of added) {
    recipes.set(name, { base, deltas: deltas.get(name) ?? [] });
  }
  log(`${part}: ${recipes.size} packages to harvest`);

  for (const [name, recipe] of recipes) {
    await harvestPackage(name, recipe);
    // Drop the blocks we just pulled, otherwise the sparse volumes grow into a
    // full copy of the part and fill the disk before the last package.
    await recipe.base.archive.reset();
  }
  fs.rmSync(partDir, { recursive: true, force: true });
}

/**
 * Empty the branch worktree before writing into it.
 *
 * `git add -A` only records a deletion when the file is gone from disk, so
 * writing over the tree accumulates whatever the client dropped: a renamed
 * catalogue leaves both names behind for good. Everything published is
 * regenerated on every run, so wiping first is what makes a removal propagate.
 */
function clearOutput(): void {
  if (!fs.existsSync(OUT)) return;
  for (const entry of fs.readdirSync(OUT)) {
    if (entry === ".git") continue; // the worktree link, not ours to touch
    fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
  }
}

/** The files that describe the branch rather than come out of the client. */
function publishRepoFiles(versionName: string): void {
  for (const stub of walk(STUBS)) {
    writeFile(path.join(OUT, "_stubs", path.relative(STUBS, stub)), fs.readFileSync(stub));
  }
  writeFile(
    path.join(OUT, "README.md"),
    [
      `# ${GUID}`,
      "",
      `Decompiled World of Tanks sources for \`${GUID}\`, currently ${versionName}.`,
      "",
      "Rebuilt daily from Wargaming's update CDN by the generator on",
      "[`main`](../../tree/main), with no game client installed. Every file here is",
      "produced by that pipeline: nothing is edited by hand, so a pull request",
      "against this branch would be overwritten by the next build.",
      "",
      "`_stubs/` is the exception, and it is not client content: it describes the",
      "engine's native modules so an IDE can resolve the scripts.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  log(`resolving ${GUID} via ${HOST}`);
  const client = await resolveClient(HOST, GUID);
  if (!client) {
    log(`${GUID}: no build published, nothing to mirror`);
    return;
  }
  log(`client ${client.versionName} (metadata ${client.version}, host ${client.host})`);

  // Cheap up-to-date guard for the cron: same build, nothing to redo.
  const versionFile = path.join(OUT, ".version_name");
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
  if (current === client.versionName && !FORCE) {
    log(`already at ${client.versionName}, nothing to do`);
    return;
  }

  clearOutput();

  const loose = path.join(workDir, "loose");
  for (const part of PACKAGE_PARTS) {
    const chain = client.getChain(part);
    if (chain.length === 0) {
      log(`no ${part} volumes, skipping`);
      continue;
    }
    await harvestPart(part, chain, loose);
  }

  // The game root, patched to the live version by the loop above.
  harvest(loose, ROOT);

  // One Python pass for every .pyc gathered above.
  if (fs.existsSync(pycRoot)) {
    log("decompiling python");
    execFileSync(PYTHON, [path.resolve("lib/py/decompile_pyc.py"), pycRoot, SOURCES], {
      stdio: "inherit",
    });
  }

  await harvestLocale(client.getChain("locale"));
  convertCatalogues(moRoot);

  publishRepoFiles(client.versionName);
  writeFile(versionFile, `${client.versionName}\n`);
  log(`done: ${OUT}`);
}

/** Turn every `.mo` gathered along the way into the published `.po`. */
function convertCatalogues(source: string): void {
  const target = path.join(SOURCES, "text", "lc_messages");
  const from = path.join(source, "text", "lc_messages");
  if (!fs.existsSync(from)) return;
  execFileSync(PYTHON, [path.resolve("lib/py/mo_to_po.py"), from, target], { stdio: "inherit" });
  log(`converted ${fs.readdirSync(target).length} catalogues from the packages`);
}

/** Localisation lives in its own part, as loose `.mo` catalogues. */
async function harvestLocale(chain: Patch[]): Promise<void> {
  if (chain.length === 0) return;
  log("harvesting locale");
  const localeDir = path.join(workDir, "locale");
  fs.mkdirSync(localeDir, { recursive: true });
  const archive = await SparseArchive.open(localeDir, chain[0].volumes);
  // Only the catalogues and the odd config are wanted here; the rest of this
  // part is multi-hundred-megabyte audio banks.
  const catalogues = [...archive.index().values()].filter((b) => /\.(mo|xml)$/i.test(b.name));
  const moDir = path.join(workDir, "mo");
  for (const block of catalogues) await archive.extract(block, moDir);
  // Non-catalogue files follow the usual rules (fontconfig.xml, loc_version).
  harvest(moDir, ROOT);

  // Lesta ships a 330-byte locale part: Мир танков is Russian-only, so its
  // catalogues travel with the client instead. Nothing to convert here, and
  // that is a normal state rather than a failure.
  const source = path.join(moDir, "res", "text", "lc_messages");
  if (!fs.existsSync(source)) {
    log("no gettext catalogues in the locale part");
    return;
  }
  execFileSync(
    PYTHON,
    [path.resolve("lib/py/mo_to_po.py"), source, path.join(SOURCES, "text", "lc_messages")],
    { stdio: "inherit" },
  );
  log(`converted ${fs.readdirSync(path.join(SOURCES, "text", "lc_messages")).length} catalogues`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // The sparse volumes are gigabytes of scratch space; a crash must not leave
  // them behind, and neither must the early return when nothing has changed.
  .finally(() => fs.rmSync(workDir, { recursive: true, force: true }));
