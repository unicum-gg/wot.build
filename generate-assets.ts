// Generator for the `unicum-gg/wot.assets` mirror's own branches.
//
// That repo is a fork of Kurzdor/wot.assets, fast-forwarded from upstream. Its
// test branch is only as fresh as upstream's, and upstream froze in July: a
// Common Test vehicle therefore has no picture anywhere, because Wargaming's
// public CDN serves released vehicles only. This rebuilds the branch from the
// client instead, the same way `generate-sources.ts` rebuilds the sources.
//
// Scope is deliberately narrower than upstream's. It mirrors the whole `gui`
// tree (21 GB), which no CI runner can hold; we take the vehicle icons, which
// is what the site actually reads, and the extraction is filtered so the rest
// never lands on disk.
//
// **This mirror accumulates, the opposite of `generate-sources.ts`.** The
// sources tree empties its worktree first, because a script the client dropped
// must stop being published: it describes what the game *is*. Assets are not
// that. Wargaming pulls an event's art when the event ends, and upstream still
// carries 23k such files: St Patrick, Grinch, Halloween, off-season Frontline,
// retired lootbox rewards. They were real, someone may still want them, and no
// later client will ever hand them back. So the run writes over the branch
// without clearing it: what the current client has is refreshed, what it no
// longer has is kept.
//
// Usage: npm run assets -- --host H --guid G --out DIR [--force]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive } from "./lib/archive.js";
import { walk, writeFile } from "./lib/harvest.js";
import { resolveClient } from "./lib/wgus.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const HOST = flag("--host") ?? "wgus-wotct.wargaming.net";
const GUID = flag("--guid") ?? "WOT.CT.PRODUCTION";
const OUT = path.resolve(flag("--out") ?? "assets-out");
// Debug: restrict the run to the named packages, like `generate-sources.ts`.
// Comma separated, because the interesting cases are about how two packages
// combine (a mode's tree against the base tree it shares paths with).
const ONLY = flag("--only")
  ?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const FORCE = args.includes("--force");

// Every package, because `gui` is not confined to the `gui-part*` ones: each
// game mode carries its own slice (frontline's hangar presets, battle pass
// cards, lootbox rewards), and taking only the gui packages left 23,263 of
// upstream's files behind. The audio banks are the one exception, gigabytes of
// Wwise blobs with no `gui` inside.
// Both parts: `client` holds most of the GUI, but `sdcontent` carries slices of
// it too, and taking only the first left whole directories (configs, effects,
// parallax) out of the mirror.
const PARTS = ["client", "sdcontent"];
const PACKAGE = /^res\/packages\/[^/]+\.pkg$/;
const SKIPPED = /(^|\/)audioww/i;

// The whole `gui` tree, which is what upstream publishes: atlases, configs,
// effects, flash, videos and the icons. Narrowing it to the vehicle icons we
// happen to read would leave every other directory frozen at whatever upstream
// last synced, which is worse than the fork we are replacing.
const PUBLISHED = "gui";

// GitHub refuses a file over 100 MiB at the pre-receive hook, and it refuses
// the whole push rather than the file: one oversized blob and nothing the run
// produced gets published. So the size is checked here rather than discovered
// by a rejected push an hour later.
//
// The cap is the platform's and nothing else. Videos belong in this mirror, the
// branch already carries several (`v_day_outro.usm` sits at 99.95 MiB, just
// under), so this must not become "skip the videos": it is the four the client
// ships past the line (`intro`, `d_day`, `scc_intro`, `scc_outro`, 104 to
// 185 MB) that cannot be hosted, and only those. They surfaced with the mode
// packages, which nothing was extracting before.
//
// Skipped files are logged, never dropped quietly: a mirror that silently omits
// something reads as a mirror that is complete.
const MAX_PUBLISHED_BYTES = 100 * 1024 * 1024;

// **A game mode's own art is one directory deeper, and taking only the root
// left every mode frozen at whatever upstream last synced.** The base packages
// hold `gui/...` at their root, but each mode ships its own package whose root
// is the mode's res directory: `comp7/gui/...`, `frontline/gui/...`,
// `fun_random/gui/...`. A pattern anchored at the root therefore matched none
// of them, and 7z reports that as an error rather than an empty result, so the
// catch below swallowed it and the run reported the package as carrying no gui
// at all. Onslaught is what made it visible: the rank crests are in `comp7.pkg`
// and nowhere else, so the mirror went on serving what upstream had synced back
// when they sat in the base packages, last written September 2024. Wargaming
// re-draws the animal every year, so the board wore a manticore through a
// dragon year and into a phoenix one.
//
// One component deep, not recursive: `*` does not cross a separator in 7z's
// matcher, which is exactly the shape we want. The mode's res directory is the
// mount point, so `comp7/gui/maps/icons/ranks/...` is published as
// `gui/maps/icons/ranks/...`, beside the base tree rather than under a root of
// its own.
const MODE_PUBLISHED = `*/${PUBLISHED}`;

// **A mode ADDS to the base tree and must never shadow it**, which is the
// opposite of what the client does and the opposite of what `paths.xml` would
// have you write: there every `res/packages/<mode>.pkg` is listed above the
// `gui-part*` ones, so the mode wins. That order is a lookup rule for a client
// that has one mode loaded at a time, and the mirror is not in a mode: it
// publishes one tree that has to be true for everyone reading it.
//
// Taking the client's order writes the mode's SHADOWING copies over the real
// ones, and those are not near-duplicates. Onslaught's package carries a
// 344-byte `gui/html_templates.xml` against the base's 80 KB, a 6 KB
// `messenger.xml` against 129 KB, and its own restyled `vehicleTypes/*` class
// icons: 31 of the 36 paths it shares with the base packages differ, every one
// of them a mode-specific override. Published flat, they would replace the
// game's own with Onslaught's, silently, and the class icons are read on every
// tank we list.
//
// So the base tree wins wherever both carry a path, and a mode contributes only
// what the base does not have. That is what makes the rank crests work: nothing
// else ships `gui/maps/icons/ranks/**` (checked against all four `gui-part*`
// packages), so they are an addition, not an override.
//
// Enforced per run rather than by ordering the packages, because they are
// walked in archive-index order and unpacked once each: re-reading 10 GB to get
// the base tree first would cost more than remembering where each path came
// from.
enum Precedence {
  Mode = 0,
  Base = 1,
}

type GuiRoot = { dir: string; from: string; precedence: Precedence };

const log = (msg: string) => console.log(`[wot.assets] ${msg}`);

/**
 * The `gui` roots inside an unpacked package: the base tree at the root, plus
 * one per mode directory. Each carries the directory its paths are relative to,
 * so both publish under `gui/`.
 */
function guiRoots(contents: string): GuiRoot[] {
  const roots: GuiRoot[] = [];
  // A package with no `gui` at all extracts nothing, so the directory itself is
  // never created. The common case, most packages are vehicles or maps.
  if (!fs.existsSync(contents)) return roots;
  if (fs.existsSync(path.join(contents, PUBLISHED))) {
    roots.push({
      dir: path.join(contents, PUBLISHED),
      from: contents,
      precedence: Precedence.Base,
    });
  }
  for (const entry of fs.readdirSync(contents, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === PUBLISHED) continue;
    const mode = path.join(contents, entry.name);
    const dir = path.join(mode, PUBLISHED);
    if (fs.existsSync(dir)) {
      roots.push({ dir, from: mode, precedence: Precedence.Mode });
    }
  }
  return roots;
}

async function main(): Promise<void> {
  log(`resolving ${GUID} via ${HOST}`);
  const client = await resolveClient(HOST, GUID);
  if (!client) {
    log(`${GUID}: no build published, nothing to mirror`);
    return;
  }
  log(`client ${client.versionName} (host ${client.host})`);

  const versionFile = path.join(OUT, ".version_name");
  const current = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, "utf8").trim()
    : null;
  if (current === client.versionName && !FORCE) {
    log(`already at ${client.versionName}, nothing to do`);
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wotassets-"));
  try {
    let total = 0;
    // Where each published path came from, so a mode's shadowing copy cannot
    // overwrite the base tree's (see `Precedence`). Keyed by the path as
    // published, and only for this run: the tree on disk is whatever the last
    // run left, which is the point of a mirror that accumulates.
    const written = new Map<string, Precedence>();
    // What the platform's size limit cost this run, reported at the end.
    const oversized: string[] = [];
    for (const part of PARTS) {
      const chain = client.getChain(part);
      if (chain.length === 0) continue;
      const partDir = path.join(workDir, part);
      fs.rmSync(partDir, { recursive: true, force: true });
      fs.mkdirSync(partDir, { recursive: true });
      const archive = await SparseArchive.open(partDir, chain[0].volumes);
      const packages = [...archive.index().values()].filter(
        (b) =>
          PACKAGE.test(b.name) &&
          !SKIPPED.test(b.name) &&
          (!ONLY || ONLY.some((name) => b.name.includes(name))),
      );
      log(`${part}: ${packages.length} packages to scan for ${PUBLISHED}`);

      for (const block of packages) {
        const unpackDir = path.join(workDir, "pkg");
        fs.rmSync(unpackDir, { recursive: true, force: true });
        const pkg = await archive.extract(block, unpackDir);
        const contents = path.join(workDir, "contents");
        fs.rmSync(contents, { recursive: true, force: true });
        // Scoped to `gui` so a package holding anything else costs nothing to
        // unpack; it is also the only tree this mirror publishes. Most packages
        // carry none at all, which 7z reports as an error rather than an empty
        // result, so it is not one here.
        try {
          execFileSync(
            "7z",
            [
              "x",
              pkg,
              `-o${contents}`,
              "-y",
              `${PUBLISHED}/*`,
              `${MODE_PUBLISHED}/*`,
            ],
            {
              stdio: "ignore",
            },
          );
        } catch {
          // no `gui` inside; the walk below simply finds nothing
        }
        let kept = 0;
        for (const { dir, from, precedence } of guiRoots(contents)) {
          for (const file of walk(dir)) {
            const rel = path.relative(from, file).split(path.sep).join("/");
            if ((written.get(rel) ?? Precedence.Mode) > precedence) continue;
            const bytes = fs.statSync(file).size;
            if (bytes > MAX_PUBLISHED_BYTES) {
              oversized.push(`${rel} (${(bytes / 1e6).toFixed(0)} MB)`);
              continue;
            }
            writeFile(path.join(OUT, rel), fs.readFileSync(file));
            written.set(rel, precedence);
            kept++;
          }
        }
        total += kept;
        log(
          `  ${path.basename(block.name)} (${(block.packed / 1e6).toFixed(0)} MB): ${kept} files`,
        );
        fs.rmSync(unpackDir, { recursive: true, force: true });
        fs.rmSync(contents, { recursive: true, force: true });
        await archive.reset();
      }
      fs.rmSync(partDir, { recursive: true, force: true });
    }

    writeFile(versionFile, `${client.versionName}\n`);
    if (oversized.length > 0) {
      log(`skipped ${oversized.length} files over GitHub's 100 MiB limit:`);
      for (const file of oversized) log(`  ! ${file}`);
    }
    log(`done: ${total} files in ${OUT}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
