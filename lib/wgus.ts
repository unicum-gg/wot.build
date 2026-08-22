// Wargaming Update Service: resolves a branch to the exact CDN URLs of the
// install `.wgpkg` volumes, without a game client anywhere.
import { fetchText } from "./http.js";

export const PROTOCOL_VERSION = "100500.6969696"; // spoofed, WGUS accepts it
const MAX_REDIRECTS = 3;

export type Volume = { url: string; size: number };
/**
 * One link of a part's install chain: the full install (`from === "0"`) or an
 * incremental patch that turns `from` into `to`.
 */
export type Patch = { from: string; to: string; volumes: Volume[] };
export type Client = {
  host: string;
  version: string;
  /** The build as players see it, e.g. `2.3.1.5412`. */
  versionName: string;
  /** Full install first, then each incremental patch in application order. */
  getChain: (part: string) => Patch[];
};

const match = (s: string, re: RegExp) => (s.match(re) ?? [])[1];
const matchAll = (s: string, re: RegExp) => [...s.matchAll(re)];

/** Compare dotted numeric versions field by field, so 2.3.1.999 < 2.3.1.5412. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Walk the patches from the full install, following `from` -> `to`.
 *
 * The chain arrives unordered and may carry links for versions this build no
 * longer reaches; anything the walk cannot reach is dropped rather than applied
 * out of order, which would corrupt every package it touches.
 *
 * Lesta's service omits `version_from` entirely, so there is nothing to follow.
 * There the order is `version_to` ascending and the full install is simply the
 * first link, which its size confirms (gigabytes against megabytes).
 */
function order(patches: Patch[]): Patch[] {
  if (patches.every((p) => p.from === "")) {
    return [...patches].sort((a, b) => compareVersions(a.to, b.to));
  }
  const full = patches.find((p) => p.from === "0");
  if (!full) return [];
  const byFrom = new Map(patches.filter((p) => p.from !== "0").map((p) => [p.from, p]));
  const chain = [full];
  for (let next = byFrom.get(full.to); next; next = byFrom.get(next.to)) chain.push(next);
  return chain;
}

/**
 * Resolve `guid` on `host`, following WGUS redirects.
 *
 * A branch can be served by a host other than the one we ask. WGUS answers the
 * move with a `redirect_url` inside `patches_chain` instead of a chain, and
 * leaves the old host serving frozen metadata: that is how the Common Test left
 * `wgus-wotct` (stuck on an April 2021 manifest) for `wgus-eu`. We follow the
 * pointer and re-resolve, since the new host carries its own metadata version.
 *
 * Resolves to `null` when the branch simply has no build published, which is a
 * normal state rather than a failure.
 */
export async function resolveClient(host: string, guid: string): Promise<Client | null> {
  let currentHost = host;
  for (let hop = 0; ; hop++) {
    const meta = await fetchText(
      `https://${currentHost}/api/v1/metadata/?guid=${guid}&chain_id=unknown&protocol_version=${PROTOCOL_VERSION}`,
    );
    const version = match(meta, /<version>([^<]+)<\/version>/);
    if (!version) throw new Error(`no metadata version for ${guid} on ${currentHost}`);
    // Some publishers redirect the app id itself (Lesta does).
    const appId = match(meta, /<redirect_application_id>([^<]+)<\/redirect_application_id>/) ?? guid;
    // The language has to be one the build ships.
    const lang = match(meta, /<default_language>([^<]+)<\/default_language>/) ?? "EN";
    const hd = match(meta, /<client_type\b[^>]*\bid="hd"[^>]*>([\s\S]*?)<\/client_type>/) ?? "";
    const parts = matchAll(hd, /<client_part\b[^>]*\bid="([^"]+)"/g).map((m) => m[1]);

    const query = new URLSearchParams({
      game_id: appId,
      protocol_version: PROTOCOL_VERSION,
      metadata_protocol_version: PROTOCOL_VERSION,
      installation_id: "wot-src",
      client_type: "hd",
      lang,
      metadata_version: version,
    });
    for (const part of parts) query.set(`${part}_current_version`, "0");
    const chain = await fetchText(`https://${currentHost}/api/v1/patches_chain/?${query}`);

    const moved = match(chain, /<redirect_url>([^<]+)<\/redirect_url>/);
    if (moved) {
      const next = new URL(moved.trim()).host;
      if (next && next !== currentHost) {
        if (hop >= MAX_REDIRECTS) throw new Error(`WGUS redirect loop for ${guid}`);
        console.log(`[wot-src] ${guid} moved: ${currentHost} -> ${next}`);
        currentHost = next;
        continue;
      }
    }

    // Scope the seed to its own block: a chain also lists torrent `<url>`s,
    // which are not range-servable mirrors.
    const seeds = match(chain, /<web_seeds>([\s\S]*?)<\/web_seeds>/) ?? "";
    const seedBase = match(seeds, /<url[^>]*>([^<]+)<\/url>/);
    if (!seedBase) return null;

    // A part ships as one full install plus the incremental patches published
    // since, each keyed by the version it upgrades from. Mirroring the full
    // install alone would freeze the tree at the last complete republication,
    // which is weeks behind: the new tanks and the rebalances all arrive as
    // patches. So we keep the whole chain and walk it.
    const byPart = new Map<string, Patch[]>();
    for (const [, patch] of matchAll(chain, /<patch>([\s\S]*?)<\/patch>/g)) {
      const part = match(patch, /<part>([^<]+)<\/part>/);
      // `version_from` is absent from Lesta's chain; `order` reads that as
      // "sort by version_to" rather than as a broken link.
      const from = match(patch, /<version_from>([^<]+)<\/version_from>/) ?? "";
      const to = match(patch, /<version_to>([^<]+)<\/version_to>/);
      if (!part || to === undefined) continue;
      const volumes = matchAll(patch, /<file>([\s\S]*?)<\/file>/g).map((m): Volume => ({
        url: seedBase + (match(m[1], /<name>([^<]+)<\/name>/) ?? "").trim(),
        size: Number(match(m[1], /<size>([^<]+)<\/size>/)),
      }));
      byPart.set(part, [...(byPart.get(part) ?? []), { from, to, volumes }]);
    }

    // The publisher stamps every patch URL with the build it belongs to, in the
    // directory rather than the file (`.../wot_2.3.1.5412_eu_yuvdes/wot_...`,
    // `.../mt_1.44.0.5163_ru_zbzti2/...` on Lesta),
    // and that is the only place the human-readable version appears; the
    // metadata only carries a timestamp. The file names carry a different,
    // much larger internal number, so the realm and hash are matched too.
    const builds = matchAll(chain, /\/[a-z]+_([0-9.]+)_[a-z0-9]+_[a-z0-9]+\//g).map((m) => m[1]);
    const versionName = builds.sort(compareVersions).at(-1) ?? version;

    return {
      host: currentHost,
      version,
      versionName,
      getChain: (part) => order(byPart.get(part) ?? []),
    };
  }
}
