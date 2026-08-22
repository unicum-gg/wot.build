// Generator for the `unicum-gg/wot.assets` mirror's own branches.
//
// That repo is a fork of Kurzdor/wot.assets, fast-forwarded from upstream. Its
// test branch is only as fresh as upstream's, and upstream froze in July: a
// Common Test vehicle therefore has no picture anywhere, because Wargaming's
// public CDN serves released vehicles only. This rebuilds the branch from the
// client instead, the same way `generate.ts` rebuilds the sources.
//
// Scope is deliberately narrower than upstream's. It mirrors the whole `gui`
// tree (21 GB), which no CI runner can hold; we take the vehicle icons, which
// is what the site actually reads, and the extraction is filtered so the rest
// never lands on disk.
//
// **This mirror accumulates, and that is the opposite of `generate.ts`.** The
// sources tree empties its worktree first, because a script the client dropped
// must stop being published: it describes what the game *is*. Assets are not
// that. Wargaming pulls an event's art when the event ends, and upstream still
// carries 23k such files: St Patrick, Grinch, Halloween, off-season Frontline,
// retired lootbox rewards. They were real, someone may still want them, and no
// later client will ever hand them back. So the run writes over the branch
// without clearing it: what the current client has is refreshed, what it no
// longer has is kept.
//
// Usage: npm run generate:assets -- --host H --guid G --out DIR [--force]
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

const log = (msg: string) => console.log(`[wot.assets] ${msg}`);

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
    for (const part of PARTS) {
      const chain = client.getChain(part);
      if (chain.length === 0) continue;
      const partDir = path.join(workDir, part);
      fs.rmSync(partDir, { recursive: true, force: true });
      fs.mkdirSync(partDir, { recursive: true });
      const archive = await SparseArchive.open(partDir, chain[0].volumes);
      const packages = [...archive.index().values()].filter(
        (b) => PACKAGE.test(b.name) && !SKIPPED.test(b.name),
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
            ["x", pkg, `-o${contents}`, "-y", `${PUBLISHED}/*`],
            {
              stdio: "ignore",
            },
          );
        } catch {
          // no `gui` inside; the walk below simply finds nothing
        }
        let kept = 0;
        for (const file of walk(path.join(contents, PUBLISHED))) {
          const rel = path.relative(contents, file).split(path.sep).join("/");
          writeFile(path.join(OUT, rel), fs.readFileSync(file));
          kept++;
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
    log(`done: ${total} files in ${OUT}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
