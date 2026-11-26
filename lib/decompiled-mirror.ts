// The versions no archived client covers.
//
// Between the last client the Internet Archive kept (0.9.7) and the first one
// our own mirror read (1.13), seven years of updates exist only as the
// decompiled client a community repository has kept branch by branch since
// 2018. It carries the arena definitions already converted to text, and no
// localization at all, so it can say where a map's bases were and not what
// the map was called: the name comes from whichever other version carries one.
//
// Its text form differs from ours in two harmless ways, both normalised here:
// the root element is named after the file (`<06_ensk.xml>`) rather than
// `<root>`, and values are padded with tabs, which every reader already trims.
import { compareVersions } from "./archived-clients.js";
import { fetchText } from "./http.js";

const REPO = "StranikS-Scan/WorldOfTanks-Decompiled";
const API = "https://api.github.com";
const DEFS = "source/res/scripts/arena_defs/";

export type DecompiledVersion = { version: string; branch: string };

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "wot.build-archive",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

/**
 * The branches naming a plain release (`0.9.12`, `1.4.1`), strictly between
 * `after` and `before`. The suffixed ones (`_SandBox`, `_CT`, `_EU`) are test
 * servers or, past 1.18, the regional split, none of which is the release.
 */
export async function decompiledVersions(after: string, before: string): Promise<DecompiledVersion[]> {
  const out: DecompiledVersion[] = [];
  for (let page = 1; page <= 5; page++) {
    const branches = await api<{ name: string }[]>(`/repos/${REPO}/branches?per_page=100&page=${page}`);
    for (const { name } of branches) {
      if (!/^\d+\.\d+(\.\d+)?$/.test(name)) continue;
      const parts = name.split(".");
      while (parts.length < 3) parts.push("0");
      const version = parts.join(".");
      if (compareVersions(version, after) > 0 && compareVersions(version, before) < 0) {
        out.push({ version, branch: name });
      }
    }
    if (branches.length < 100) break;
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** Arena id -> definition text, for one branch. Empty when the branch carries
 * none (several 0.9 ones hold the scripts and no `arena_defs`). */
export async function decompiledArenaDefs(branch: string): Promise<Map<string, string>> {
  const tree = await api<{ tree: { path: string; type: string }[] }>(
    `/repos/${REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  const files = tree.tree
    .filter((t) => t.type === "blob" && t.path.startsWith(DEFS) && t.path.endsWith(".xml"))
    .map((t) => t.path.slice(DEFS.length, -".xml".length))
    .filter((id) => !id.includes("/"));
  const out = new Map<string, string>();
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      const raw = await fetchText(
        `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(branch)}/${DEFS}${id}.xml`,
      );
      out.set(id, normalise(raw, id));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** Rename the file-named root to `<root>` so the text reads like the rest. */
function normalise(xml: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = xml
    .replace(new RegExp(`^\\s*<${escaped}\\.xml>`), "<root>")
    .replace(new RegExp(`</${escaped}\\.xml>\\s*$`), "</root>");
  return `<?xml version="1.0" encoding="utf-8"?>\n${body.trim()}\n`;
}
