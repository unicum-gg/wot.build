// The game clients nobody but the Internet Archive kept.
//
// Wargaming publishes no archive of past clients and the update CDN only ever
// serves the current build, so a map pulled from the game in 2014 exists today
// in exactly one place: the full EU installs players uploaded to archive.org to
// keep their old replays playable. They are whole clients, not mods or dumps,
// so their arena definitions, their localization and their minimaps are
// Wargaming's own files at that version.
//
// Each is one solid 7-Zip, which is why they are read through
// `py/stream_7z.py` rather than `archive.ts`: there is no per-package block to
// range into, only one stream to decode from the start and walk away from early.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fetchText } from "./http.js";

const PYTHON = process.env.WOTSRC_PYTHON ?? "python3";
const STREAM = path.resolve(import.meta.dirname, "py/stream_7z.py");

/**
 * The items holding full EU clients. One holds a version per folder, the other
 * the one later build (0.9.7) uploaded on its own; the versions themselves are
 * read off the file names rather than listed here.
 */
const ITEMS = ["world-of-tanks-versions", "world-of-tanks-0.9.7-b43"];

export type ArchivedClient = {
  /** Three-part game version, the shape the mirrors already use (`0.8.11`). */
  version: string;
  build: number;
  url: string;
};

/** `World_of_Tanks_0.08.11.00.00_EU_0587_SD.7z` and `World_of_Tanks_0.9.07_#43.7z`. */
const CLIENT_FILE =
  /World_of_Tanks_0*(\d+)\.0*(\d+)\.0*(\d+)(?:\.\d+\.\d+)?(?:_EU)?_#?0*(\d+)(?:_(?:SD|HD))?\.7z$/;

/** Every archived EU client, the last build of each version, oldest first. */
export async function archivedClients(): Promise<ArchivedClient[]> {
  const best = new Map<string, ArchivedClient>();
  for (const item of ITEMS) {
    const meta = JSON.parse(await fetchText(`https://archive.org/metadata/${item}/files`)) as {
      result: { name: string }[];
    };
    for (const { name } of meta.result) {
      const m = CLIENT_FILE.exec(name);
      if (!m) continue;
      const version = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
      const build = Number(m[4]);
      const url = `https://archive.org/download/${item}/${name.split("/").map(encodeURIComponent).join("/")}`;
      const known = best.get(version);
      if (!known || build > known.build) best.set(version, { version, build, url });
    }
  }
  return [...best.values()].sort((a, b) => compareVersions(a.version, b.version));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type ArchivedEntry = { path: string; size: number; modified: string | null };

/** Every stored entry of a client, read from its headers alone. */
export function listClient(client: ArchivedClient): ArchivedEntry[] {
  const out = execFileSync(PYTHON, [STREAM, "list", client.url], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArchivedEntry);
}

/** Decode the client's stream into `out`, keeping the entries matching `pattern`. */
export function extractFromClient(
  client: ArchivedClient,
  out: string,
  pattern: string,
  log: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-u", STREAM, "extract", client.url, out, pattern]);
    child.stdout.on("data", (b: Buffer) => {
      for (const line of b.toString().split("\n")) if (line.trim()) log(`  ${line.trim()}`);
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`stream_7z exited ${code}: ${stderr.slice(-800)}`)),
    );
  });
}
