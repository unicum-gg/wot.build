// Turning an unpacked package into the published tree.
//
// Upstream keeps sources only, and "source" means anything the client stores as
// a packed section, whatever its extension: `.xml` and `.def` under `scripts`,
// but also the `.model`, `.visual_processed`, `.mfm` and `.seq` that make up
// `vehicles`, `content` and `particles`. So the decision is made on the bytes.
// Plain-text files are kept by extension, everything else (textures, sounds,
// video, web assets) is dropped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decodePacked, isPackedFile } from "./packed.js";
import { toXml } from "./serialize.js";

const KEPT_TEXT = new Set([".txt"]);

// Two families of binaries survive upstream's filter, and only these: the
// compiled ActionScript libraries, kept next to their decompiled form, and the
// vehicle contour icons, which are data rather than decoration (they are the
// only PNGs in the whole mirror).
const COPIED_BINARY = [/\.swc$/i, /^gui\/maps\/icons\/vehicle\/contour\/[^/]+\.png$/i];

export type Stats = { xml: number; copied: number; swc: number };
export type Harvester = {
  /** Where `.pyc` accumulate for the single decompiler pass at the end. */
  pycRoot: string;
  /** Where `.mo` catalogues accumulate for the single conversion at the end. */
  moRoot: string;
  harvest: (root: string, dest: string) => Stats;
};

export function writeFile(target: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** Walk a directory, yielding every file path. */
export function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

export function createHarvester(options: {
  workDir: string;
  sourcesAs3: string;
  ffdecJar: string;
  log: (msg: string) => void;
}): Harvester {
  const { workDir, sourcesAs3, ffdecJar, log } = options;
  const pycRoot = path.join(workDir, "pyc");
  const moRoot = path.join(workDir, "mo-packages");

  /**
   * A `.swc` is a zip holding `library.swf`; that is what carries the classes.
   *
   * Returns false when the decompiler refuses one library. That must not abort a
   * run that has already spent minutes downloading: the failure is reported and
   * the remaining packages carry on.
   */
  function decompileSwc(swc: string): boolean {
    // `foo-1.0-SNAPSHOT.swc` publishes as `sources-as3/foo/`.
    const library = path.basename(swc, ".swc").replace(/-\d+(\.\d+)*-SNAPSHOT$/, "");
    const unpacked = path.join(workDir, "swc", library);
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.mkdirSync(unpacked, { recursive: true });
    execFileSync("7z", ["x", swc, `-o${unpacked}`, "-y"], { stdio: "ignore" });
    const swf = path.join(unpacked, "library.swf");
    if (!fs.existsSync(swf)) {
      log(`  ! ${library}: no library.swf inside the swc`);
      return false;
    }
    try {
      execFileSync("java", ["-jar", ffdecJar, "-export", "script", path.join(sourcesAs3, library), swf], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 << 20,
      });
      return true;
    } catch (e) {
      const err = e as { stderr?: Buffer; stdout?: Buffer };
      const detail = (err.stderr?.toString() || err.stdout?.toString() || "").trim().split("\n").slice(-3).join(" | ");
      log(`  ! ${library}: ffdec failed (${detail || "no output"})`);
      return false;
    }
  }

  function harvest(root: string, dest: string): Stats {
    const stats: Stats = { xml: 0, copied: 0, swc: 0 };
    for (const file of walk(root)) {
      const rel = path.relative(root, file);
      const ext = path.extname(file).toLowerCase();

      if (ext === ".pyc") {
        // Batched later: one Python process for the whole tree, not one per file.
        writeFile(path.join(pycRoot, rel), fs.readFileSync(file));
        continue;
      }
      if (ext === ".mo") {
        // A Russian-only build has no separate locale part, so its gettext
        // catalogues travel inside the packages. Converted with the others.
        writeFile(path.join(moRoot, rel), fs.readFileSync(file));
        continue;
      }
      if (ext === ".swc") {
        if (decompileSwc(file)) stats.swc++;
        // fall through: the archive itself is published too
      }
      if (COPIED_BINARY.some((re) => re.test(rel))) {
        writeFile(path.join(dest, rel), fs.readFileSync(file));
        stats.copied++;
        continue;
      }
      if (ext === ".swc") continue;
      if (isPackedFile(file)) {
        writeFile(path.join(dest, rel), toXml(decodePacked(fs.readFileSync(file))));
        stats.xml++;
        continue;
      }
      // `.xml`/`.def` occasionally ship as plain text rather than packed.
      if (KEPT_TEXT.has(ext) || ext === ".xml" || ext === ".def") {
        writeFile(path.join(dest, rel), fs.readFileSync(file));
        stats.copied++;
      }
    }
    return stats;
  }

  return { pycRoot, moRoot, harvest };
}
