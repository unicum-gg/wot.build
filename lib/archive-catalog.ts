// The catalogue of every map the game no longer ships.
//
// The versions the archive rebuilt end where our own mirror begins (1.13), and
// maps have kept leaving since, so "retired" can only be decided over the whole
// timeline: the archived versions first, then every version the `wot.src` EU
// branch has a commit for. An arena is retired when the current client no
// longer defines it, and what is published for it is the state it left in:
// its last definition, the first and last versions that carried it, and the
// name the client gave it.
//
// The name is read newest first: the current client's own strings, which keep
// naming maps years after pulling them (Highway, Serene Coast), then the newest
// archived version that named it. The versions between 0.9.12 and 1.12 carry no
// strings, so a map that lived only there keeps no name from this pass.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SparseArchive } from "./archive.js";
import { compareVersions } from "./archived-clients.js";
import { archivedEnglishLocales } from "./archived-installs.js";
import { fetchText } from "./http.js";

export const SRC_REPO = "unicum-gg/wot.src";
export const DEFS = "sources/res/scripts/arena_defs";
const PO = "sources/res/text/lc_messages/arenas.po";

export type TimelineVersion = {
  version: string;
  date: string | null;
  /** Where its definitions are read: a local archive folder or a mirror commit. */
  dir?: string;
  sha?: string;
  arenas: string[];
};

export type RetiredArena = {
  name: string | null;
  description: string | null;
  firstVersion: string;
  lastVersion: string;
  /** The date the last version carrying it shipped, i.e. the last month it was
   * playable. Null when that version could not be dated. */
  lastDate: string | null;
  /** Which branch of the minimap mirror draws it: `ARCHIVE` for the ones cut
   * from an archived client, `WG` for a map retired since the live mirror began
   * (it keeps the images it published), null when no source had one. */
  minimap: "ARCHIVE" | "WG" | null;
};

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "wot.build-archive",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`github ${res.status} ${url}`);
  return (await res.json()) as T;
}

/** Newest commit per game version on a mirror branch, oldest first (the same
 * reading the site's history backfill makes of the commit subjects). */
export async function mirrorVersions(branch = "EU"): Promise<{ version: string; sha: string; date: string }[]> {
  const best = new Map<string, { version: string; sha: string; date: string }>();
  for (let page = 1; page <= 30; page++) {
    const commits = await api<{ sha: string; commit: { message: string; committer: { date: string } } }[]>(
      `/repos/${SRC_REPO}/commits?sha=${branch}&per_page=100&page=${page}`,
    );
    for (const c of commits) {
      // Two subject formats over the branch's life: `v.2.3.1.1 #910`, then
      // `update EU sources to 2.4.1.5498` once it was built by us.
      const m = /(?:v\.|sources to )(\d+\.\d+\.\d+)\.\d+/.exec(c.commit.message);
      if (!m) continue;
      const date = c.commit.committer.date;
      const known = best.get(m[1]);
      if (!known || date > known.date) best.set(m[1], { version: m[1], sha: c.sha, date });
    }
    if (commits.length < 100) break;
  }
  return [...best.values()].sort((a, b) => compareVersions(a.version, b.version));
}

/** The arena ids a mirror commit defines, by walking down to the folder rather
 * than listing a three-gigabyte tree. */
async function arenasAt(sha: string): Promise<string[]> {
  let tree = (await api<{ tree: { sha: string } }>(`/repos/${SRC_REPO}/git/commits/${sha}`)).tree.sha;
  for (const segment of DEFS.split("/")) {
    const listing = await api<{ tree: { path: string; sha: string; type: string }[] }>(
      `/repos/${SRC_REPO}/git/trees/${tree}`,
    );
    const next = listing.tree.find((t) => t.path === segment && t.type === "tree");
    if (!next) return [];
    tree = next.sha;
  }
  const listing = await api<{ tree: { path: string }[] }>(`/repos/${SRC_REPO}/git/trees/${tree}`);
  return listing.tree
    .map((t) => t.path)
    .filter((p) => p.endsWith(".xml"))
    .map((p) => p.slice(0, -4));
}

/**
 * The names only a Russian client ever gave. The one archived client that
 * shipped these three maps (0.9.7) is a Russian build, no English client of
 * those months survives and no later one names them, so their English names
 * are written here, as the game's English client spelled them.
 */
const ENGLISH_ONLY_FROM_HERE: Record<string, string> = {
  "100_thepit/name": "Mittengard",
  "103_ruinberg_winter/name": "Winterberg",
  "95_lost_city/name": "Lost City",
};

const CYRILLIC = /[\u0400-\u04ff]/;

/**
 * The English strings of every archived install since 1.19.1, newest first, as
 * one map. Each locale package is a non-solid 7z, so `arenas.mo` is one small
 * block: the read is the package's header and eight kilobytes.
 */
async function archivedEnglishNames(
  log: (msg: string) => void,
  moToPo: (mo: string) => string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { version, volume } of await archivedEnglishLocales()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locale-"));
    try {
      const archive = await SparseArchive.open(dir, [volume]);
      const block = archive.index().get("res/text/lc_messages/arenas.mo");
      if (!block) continue;
      const mo = await archive.extract(block, path.join(dir, "x"));
      for (const [key, value] of parsePo(moToPo(mo))) if (!out.has(key)) out.set(key, value);
    } catch (error) {
      log(`  ~ ${version} English locale: ${(error as Error).message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  log(`${out.size} strings from the archived English locales`);
  return out;
}

/** How the old clients write an empty string: a description nobody wrote reads
 * `?empty?` in their catalogue, and published as such it reads that on the page. */
const EMPTY = "?empty?";

/** `key -> value` of a `.po` text. */
export function parsePo(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const entry = /msgid\s+"((?:[^"\\]|\\.)*)"\s*\r?\nmsgstr\s+"((?:[^"\\]|\\.)*)"/g;
  for (const [, key, value] of text.matchAll(entry)) {
    if (key && value && value.trim() !== EMPTY) out.set(key.replace(/\\(.)/g, "$1"), value.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** The full timeline: archived versions from `versionsDir`, then the mirror's. */
export async function timeline(
  versionsDir: string,
  log: (msg: string) => void,
): Promise<TimelineVersion[]> {
  const archived = JSON.parse(fs.readFileSync(path.join(versionsDir, "versions.json"), "utf8")) as {
    version: string;
    date: string | null;
    arenas: string[];
  }[];
  const out: TimelineVersion[] = archived.map((v) => ({
    version: v.version,
    date: v.date,
    dir: path.join(versionsDir, v.version),
    arenas: v.arenas,
  }));
  for (const v of await mirrorVersions()) {
    const arenas = await arenasAt(v.sha);
    log(`mirror ${v.version}: ${arenas.length} arenas`);
    out.push({ version: v.version, date: v.date.slice(0, 10), sha: v.sha, arenas });
  }
  return out;
}

export async function definitionAt(v: TimelineVersion, id: string): Promise<string> {
  if (v.dir) return fs.readFileSync(path.join(v.dir, DEFS, `${id}.xml`), "utf8");
  return fetchText(`https://raw.githubusercontent.com/${SRC_REPO}/${v.sha}/${DEFS}/${id}.xml`);
}

export type Retired = {
  first: TimelineVersion;
  last: TimelineVersion;
  /** Its last definition. */
  xml: string;
};

/** Every arena the current client no longer defines, with the version it left
 * in and its definition there. A garage declares no gameplay type, the rule the
 * live catalogue keeps maps by, and is left out. The garages of the 0.x years
 * are the exception that rule does not see: `hangar_halloween` and the premium
 * ones carry a `<ctf>` block, so they are recognised by their id, which is the
 * one thing all of them share. */
export async function retiredArenas(versions: TimelineVersion[]): Promise<Map<string, Retired>> {
  const current = new Set(versions.at(-1)!.arenas);
  const first = new Map<string, TimelineVersion>();
  const last = new Map<string, TimelineVersion>();
  for (const v of versions) {
    for (const id of v.arenas) {
      if (id.startsWith("_")) continue;
      if (!first.has(id)) first.set(id, v);
      last.set(id, v);
    }
  }
  const out = new Map<string, Retired>();
  for (const [id, lastVersion] of [...last].sort(([a], [b]) => a.localeCompare(b))) {
    if (current.has(id) || id.toLowerCase().startsWith("hangar")) continue;
    const xml = await definitionAt(lastVersion, id);
    if (!xml.includes("<gameplayTypes>")) continue;
    out.set(id, { first: first.get(id)!, last: lastVersion, xml });
  }
  return out;
}

/** Write `arena_defs/<id>.xml` and `index.json` for every retired battle arena. */
export async function writeCatalog(
  versions: TimelineVersion[],
  retired: Map<string, Retired>,
  out: string,
  live: ReadonlySet<string>,
  log: (msg: string) => void,
  moToPo: (mo: string) => string,
): Promise<Record<string, RetiredArena>> {
  // Names newest first: today's client strings, then the archived installs'
  // English ones since 1.19.1, then each archived client's own, newest to
  // oldest. Only English is taken past today's client: the site names maps in
  // English and translates from there, and one archived client (0.9.7) is a
  // Russian build.
  const head = parsePo(await fetchText(`https://raw.githubusercontent.com/${SRC_REPO}/EU/${PO}`));
  const installs = await archivedEnglishNames(log, moToPo);
  const archivedPos = [
    installs,
    ...versions
      .filter((v) => v.dir && fs.existsSync(path.join(v.dir, PO)))
      .reverse()
      .map((v) => parsePo(fs.readFileSync(path.join(v.dir!, PO), "utf8"))),
    new Map(Object.entries(ENGLISH_ONLY_FROM_HERE)),
  ];
  // Then the strings of the mirror commit an arena left at: an event map is
  // named by the client that ran the event and dropped with it. The mirror's
  // first commits come from a Russian client, so a name in Cyrillic is not
  // taken, the site names maps in English before translating them.
  const commitPos = new Map<string, Promise<Map<string, string>>>();
  const poAt = (sha: string) => {
    if (!commitPos.has(sha)) {
      commitPos.set(
        sha,
        fetchText(`https://raw.githubusercontent.com/${SRC_REPO}/${sha}/${PO}`)
          .then(parsePo)
          .catch(() => new Map<string, string>()),
      );
    }
    return commitPos.get(sha)!;
  };
  const lookup = async (key: string, at: TimelineVersion) => {
    if (head.has(key)) return head.get(key)!;
    for (const po of archivedPos) {
      const value = po.get(key);
      if (value && !CYRILLIC.test(value)) return value;
    }
    if (at.sha) {
      const value = (await poAt(at.sha)).get(key);
      if (value && !CYRILLIC.test(value)) return value;
    }
    return null;
  };

  const defsDir = path.join(out, "arena_defs");
  fs.rmSync(defsDir, { recursive: true, force: true });
  fs.mkdirSync(defsDir, { recursive: true });
  const index: Record<string, RetiredArena> = {};
  for (const [id, { first, last, xml }] of retired) {
    fs.writeFileSync(path.join(defsDir, `${id}.xml`), xml);
    index[id] = {
      name: await lookup(`${id}/name`, last),
      description: await lookup(`${id}/description`, last),
      firstVersion: first.version,
      lastVersion: last.version,
      lastDate: last.date,
      minimap: fs.existsSync(path.join(out, "maps", `${id}.webp`))
        ? "ARCHIVE"
        : live.has(id)
          ? "WG"
          : null,
    };
  }
  fs.writeFileSync(path.join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const named = Object.values(index).filter((a) => a.name).length;
  const drawn = Object.values(index).filter((a) => a.minimap).length;
  log(`catalogue: ${Object.keys(index).length} retired arenas, ${named} named, ${drawn} with a minimap`);
  return index;
}
