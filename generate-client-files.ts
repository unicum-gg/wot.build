// The handful of client files a mod is BUILT against, read off the update CDN
// at the live build, so a mod can be released without a game installed.
//
// unicum.gg-mod links against the client's own `.swc` libraries and patches
// `battleVehicleMarkersApp.swf`, which then ships inside the `.wotmod` and
// REPLACES the client's copy. A package built against any other build hands
// every player the vehicle markers of a client they are not running, and the
// difference is invisible until it is in somebody's game. That is why it was
// cut by hand on a machine with the game installed.
//
// The wot.assets mirror carries the same files, and is not enough on its own:
// it is refreshed once a day, so on a release day it can be a build behind, and
// it stamps a build number (`2.4.1.5504`) while the mod targets the folder the
// client reads (`mods/2.4.1.1`). Nothing in the mirror ties the two together.
// Reading both here, out of the same chain in the same run, is what lets the
// caller refuse a package whose files and folder came from different builds.
//
// Writes, under --out:
//   gui/flash/battleVehicleMarkersApp.swf
//   gui/flash/swc/*.swc
//   paths.xml
//   manifest.json   { versionName, mods, files: { path: sha256 } }
//
// Usage: npm run client-files -- [--host H] [--guid G] --out DIR
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive } from "./lib/archive.js";
import { walk, writeFile } from "./lib/harvest.js";
import { drainPatches, rebuildPackage, recipes } from "./lib/patched.js";
import { resolveClient } from "./lib/wgus.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const HOST = flag("--host") ?? "wgus-woteu.wargaming.net";
const GUID = flag("--guid") ?? "WOT.EU.PRODUCTION";
const OUT = path.resolve(flag("--out") ?? "client-files");

// The base `gui` tree lives in these, and only the base tree: a game mode's
// package can shadow a path for its own mode, which is not what the markers
// app every battle loads is.
const PACKAGE = /^res\/packages\/gui-part[^/]*\.pkg$/;
const MARKERS_APP = "gui/flash/battleVehicleMarkersApp.swf";
const SWC = /^gui\/flash\/swc\/[^/]+\.swc$/;
const PATHS = "paths.xml";

const log = (msg: string) => console.log(`[client-files] ${msg}`);

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main(): Promise<void> {
  log(`resolving ${GUID} via ${HOST}`);
  const client = await resolveClient(HOST, GUID);
  if (!client) throw new Error(`${GUID}: no build published`);
  log(`client ${client.versionName}`);

  const chain = client.getChain("client");
  if (chain.length === 0) throw new Error("no install chain for the client part");
  const [full, ...patches] = chain;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "clientfiles-"));
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    const partDir = path.join(workDir, "part");
    fs.mkdirSync(partDir, { recursive: true });
    const archive = await SparseArchive.open(partDir, full.volumes);

    // paths.xml is a loose file at the root of the part, rewritten by any patch
    // that moves the mods folder, so the newest copy in the chain wins. Patches
    // are read newest first and the full install only if none carried one.
    const loose = path.join(workDir, "loose");
    let pathsFound = false;
    for (const [i, patch] of [...patches.entries()].reverse()) {
      const dir = path.join(workDir, `paths-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const patchArchive = await SparseArchive.open(dir, patch.volumes);
      const block = patchArchive.index().get(PATHS);
      if (block && block.packed > 0) {
        await patchArchive.extract(block, loose);
        pathsFound = true;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (pathsFound) break;
    }
    if (!pathsFound) {
      const block = archive.index().get(PATHS);
      if (!block) throw new Error(`no ${PATHS} in the client part`);
      await archive.extract(block, loose);
    }
    const pathsXml = fs.readFileSync(path.join(loose, PATHS), "utf8");
    const mods = /\.\/mods\/([0-9][0-9.]*)/.exec(pathsXml)?.[1];
    if (!mods) throw new Error(`${PATHS} names no mods folder`);
    writeFile(path.join(OUT, PATHS), pathsXml);
    log(`mods folder ${mods}`);

    const wanted = (name: string) => PACKAGE.test(name);
    const drained = await drainPatches(patches, workDir, wanted, log);
    const plan = recipes(archive, [...archive.index().values()], wanted, drained);
    if (plan.size === 0) throw new Error("no gui-part package in the client part");

    const files: Record<string, string> = {};
    for (const [name, recipe] of plan) {
      const unpackDir = path.join(workDir, "pkg");
      const contents = path.join(workDir, "contents");
      fs.rmSync(unpackDir, { recursive: true, force: true });
      fs.rmSync(contents, { recursive: true, force: true });
      const pkg = await rebuildPackage(recipe, unpackDir);
      // Most gui-part packages carry neither, which 7z reports as an error
      // rather than as an empty result.
      try {
        execFileSync("7z", ["x", pkg, `-o${contents}`, "-y", MARKERS_APP, "gui/flash/swc/*.swc"], {
          stdio: "ignore",
        });
      } catch {
        // nothing of ours in this package
      }
      if (fs.existsSync(contents)) {
        for (const file of walk(contents)) {
          const rel = path.relative(contents, file).split(path.sep).join("/");
          if (rel !== MARKERS_APP && !SWC.test(rel)) continue;
          if (files[rel]) throw new Error(`${rel} is in two gui packages`);
          writeFile(path.join(OUT, rel), fs.readFileSync(file));
          files[rel] = sha256(file);
        }
      }
      log(`  ${path.basename(name)}: ${Object.keys(files).length} files so far`);
      fs.rmSync(unpackDir, { recursive: true, force: true });
      fs.rmSync(contents, { recursive: true, force: true });
      await recipe.base.archive.reset();
    }

    if (!files[MARKERS_APP]) throw new Error(`${MARKERS_APP} is in no gui package`);
    if (!Object.keys(files).some((rel) => SWC.test(rel))) throw new Error("no client .swc found");

    const manifest = { versionName: client.versionName, mods, files };
    writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`done: ${Object.keys(files).length} files for mods/${mods} (${client.versionName})`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
