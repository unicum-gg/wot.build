// Publishes what `generate-archive.ts` rebuilt, as the `ARCHIVE` branch of the
// two mirrors that read it.
//
// `wot.src` gets one commit per archived version, oldest first, dated when that
// update shipped and with the subject a live branch's commits carry
// (`v.0.8.11.0 #587`). That shape is the whole contract: the site's history
// backfill enumerates a branch's versions from its commit subjects and orders
// them by commit date, so with it the archive reads exactly like the EU branch.
//
// `wot.maps` gets the catalogue of retired maps as a single commit: the
// minimaps, the last definitions and `index.json`. It describes the past as it
// is known today rather than a sequence of versions, so it has no history to
// keep and is rewritten whole.
//
// Both branches are orphans and are rebuilt from scratch on every run, then
// force-pushed: they hold nothing but what this produces.
//
// Usage: npm run archive:publish -- --versions DIR --catalog DIR
//          [--src-repo PATH] [--maps-repo PATH] [--push]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const VERSIONS = path.resolve(flag("--versions") ?? "archive/versions");
const CATALOG = path.resolve(flag("--catalog") ?? "archive/minimaps");
const SRC_REPO = flag("--src-repo") ?? "https://github.com/unicum-gg/wot.src.git";
const MAPS_REPO = flag("--maps-repo") ?? "https://github.com/unicum-gg/wot.maps.git";
const PUSH = args.includes("--push");
const BRANCH = "ARCHIVE";

const log = (msg: string) => console.log(`[archive:publish] ${msg}`);

type Version = {
  version: string;
  date: string | null;
  source: "client" | "decompiled";
  build?: number;
};

function git(cwd: string, gitArgs: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 256 << 20,
  });
}

/** A fresh orphan branch in an empty clone-less repository pointed at `remote`. */
function orphanRepo(remote: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-publish-"));
  git(dir, ["init", "-q", "-b", BRANCH]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["config", "user.name", "wot.build"]);
  git(dir, ["config", "user.email", "actions@users.noreply.github.com"]);
  return dir;
}

function emptyWorktree(dir: string) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== ".git") fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * The date a commit carries. An undated version (an archived client repacked
 * years later, with nothing else to date it) borrows the day before the next
 * dated version, or the day after the previous one at the end of the list:
 * that keeps the order, the one thing the reader of these commits relies on,
 * stays as close to the truth as the neighbours allow, and the subject says it
 * was inferred.
 */
function commitDates(versions: Version[]): Map<string, { date: string; inferred: boolean }> {
  const out = new Map<string, { date: string; inferred: boolean }>();
  const shift = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    if (v.date) {
      out.set(v.version, { date: v.date, inferred: false });
      continue;
    }
    // The undated run this version starts, and the dated version after it.
    let end = i;
    while (end < versions.length && !versions[end].date) end++;
    const next = versions[end]?.date;
    const previous = i > 0 ? out.get(versions[i - 1].version)!.date : "2010-01-01";
    const date = next ? shift(next, -(end - i)) : shift(previous, 1);
    out.set(v.version, { date, inferred: true });
  }
  return out;
}

function publishVersions() {
  const versions = JSON.parse(fs.readFileSync(path.join(VERSIONS, "versions.json"), "utf8")) as Version[];
  const dates = commitDates(versions);
  const repo = orphanRepo(SRC_REPO);
  for (const v of versions) {
    emptyWorktree(repo);
    fs.cpSync(path.join(VERSIONS, v.version), repo, { recursive: true });
    fs.writeFileSync(path.join(repo, ".version_name"), `${v.version}.${v.build ?? 0}\n`);
    git(repo, ["add", "-A"]);
    const { date, inferred } = dates.get(v.version)!;
    const origin =
      v.source === "client"
        ? `archived EU client${v.build ? ` #${v.build}` : ""}`
        : "decompiled mirror";
    const subject = `v.${v.version}.${v.build ?? 0} #${v.build ?? 0} (${origin}${inferred ? ", date inferred" : ""})`;
    const stamp = `${date}T12:00:00Z`;
    git(repo, ["commit", "-q", "--allow-empty", "-m", subject], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
    log(`wot.src ${subject} @ ${date}`);
  }
  return repo;
}

function publishCatalog() {
  const repo = orphanRepo(MAPS_REPO);
  for (const entry of ["maps", "arena_defs", "index.json", "history"]) {
    const from = path.join(CATALOG, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(repo, entry), { recursive: true });
  }
  fs.writeFileSync(
    path.join(repo, "README.md"),
    [
      "# Retired maps",
      "",
      "Every battle map World of Tanks no longer ships, as it was in the last update",
      "that had it: `maps/<arena>.webp` (the minimap, 2048px), `arena_defs/<arena>.xml`",
      "(the last definition) and `index.json` (its name and the versions it was in).",
      "",
      "`history/` is what each update did to every map's look: `history/index.json`",
      "(the terrain, objects and minimap each rework touched, with its images), and",
      "`history/legacy-minimaps.json`, the minimap of every map in the clients of 0.6.2",
      "to 0.9.7, one image per version that redrew it.",
      "",
      "Rebuilt by `unicum-gg/wot.build`'s `generate-archive` from the full EU clients",
      "preserved on the Internet Archive, a decompiled mirror of the versions after",
      "them, and the `wot.src` history since 1.13.",
      "",
    ].join("\n"),
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "retired maps catalogue"]);
  log(`wot.maps catalogue committed`);
  return repo;
}

function push(repo: string) {
  git(repo, ["push", "--force", "origin", BRANCH]);
  log(`pushed ${BRANCH} from ${repo}`);
}

const src = publishVersions();
const maps = publishCatalog();
if (PUSH) {
  push(src);
  push(maps);
} else {
  log(`dry run: review ${src} and ${maps}, then rerun with --push`);
}
