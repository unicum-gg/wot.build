// The update CDN's own install packages, for the versions it no longer serves.
//
// Someone has been uploading every EU build's `.wgpkg` files to the Internet
// Archive since 1.19.1 (2023), straight off the update CDN: the full install of
// each part plus the patches between builds, the same files WGUS hands us for
// the live client. So for those versions the live pipeline's own reader applies
// unchanged: an install part is a 7-Zip with one block per package, read sparse,
// and a map's package is one range request. That is what reaches the event maps
// retired since our mirror began, which no other archive carries.
import { compareVersions } from "./archived-clients.js";
import { fetchText } from "./http.js";
import type { Volume } from "./wgus.js";

const ITEMS = ["world-of-tanks-wgc", "world-of-tanks-wgc-2"];

/** The parts a map package can sit in, the first wins. */
export const MAP_PARTS = ["client", "sdcontent"];

export type ArchivedInstall = {
  /** Three-part game version (`1.24.1`). */
  version: string;
  /** Part name -> its full install, a single volume. */
  parts: Map<string, Volume>;
};

/** `wot_1.19.1.22434_client.wgpkg`: a full install, not a patch (which names
 * two builds, `wot_<to>_<from>_<part>.wgpkg`). */
const FULL_INSTALL = /^wot_(\d+)\.(\d+)\.(\d+)\.\d+_([a-z]+)\.wgpkg$/;

/** The newest full install of each version, newest version first. */
export async function archivedInstalls(): Promise<ArchivedInstall[]> {
  const best = new Map<string, { build: string; install: ArchivedInstall }>();
  for (const item of ITEMS) {
    const meta = JSON.parse(await fetchText(`https://archive.org/metadata/${item}/files`)) as {
      result: { name: string; size?: string }[];
    };
    for (const file of meta.result) {
      const [folder, name] = file.name.split("/");
      if (!name || folder === "locale") continue;
      const m = FULL_INSTALL.exec(name);
      if (!m) continue;
      const version = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
      const part = m[4];
      const known = best.get(version);
      // Several builds of one version are uploaded; the folder names the build.
      if (known && known.build > folder) continue;
      if (!known || known.build < folder) {
        best.set(version, { build: folder, install: { version, parts: new Map() } });
      }
      best.get(version)!.install.parts.set(part, {
        url: `https://archive.org/download/${item}/${folder}/${name}`,
        size: Number(file.size ?? 0),
      });
    }
  }
  return [...best.values()]
    .map((b) => b.install)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** `wot_1.24.1.23011_1.24.1.22994_sdcontent.wgpkg`: the patch from one build to
 * the next. */
const PATCH = /^wot_(\d+)\.(\d+)\.(\d+)\.\d+_\d+\.\d+\.\d+\.\d+_([a-z]+)\.wgpkg$/;

/**
 * Every patch uploaded beside the installs, newest version first.
 *
 * They matter for one thing the installs miss: the event maps. Wargaming adds
 * an event's arena in a patch partway through a version and pulls it before
 * the next, so it is in no full install at all, only in the patch that
 * introduced it, stored whole there (`281_cosmic.pkg` in 1.24.1's 22994 to
 * 23011, Paperland in 1.27.0's). A package the patch only changed is stored as
 * a diff (`.rdiff`, `.xdiff`) and is no use on its own.
 */
export async function archivedPatches(): Promise<{ version: string; part: string; volume: Volume }[]> {
  const out: { version: string; part: string; volume: Volume }[] = [];
  for (const item of ITEMS) {
    const meta = JSON.parse(await fetchText(`https://archive.org/metadata/${item}/files`)) as {
      result: { name: string; size?: string }[];
    };
    for (const file of meta.result) {
      const [folder, name] = file.name.split("/");
      if (!name || folder === "locale") continue;
      const m = PATCH.exec(name);
      if (!m) continue;
      out.push({
        version: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`,
        part: m[4],
        volume: { url: `https://archive.org/download/${item}/${folder}/${name}`, size: Number(file.size ?? 0) },
      });
    }
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** The English locale package of each archived version, newest first. */
export async function archivedEnglishLocales(): Promise<{ version: string; volume: Volume }[]> {
  const out = new Map<string, { folder: string; volume: Volume }>();
  for (const item of ITEMS) {
    const meta = JSON.parse(await fetchText(`https://archive.org/metadata/${item}/files`)) as {
      result: { name: string; size?: string }[];
    };
    for (const file of meta.result) {
      const m = /^locale\/(wot_(\d+)\.(\d+)\.(\d+)\.\d+_[^/]+)\/[^/]+_locale_en\.wgpkg$/.exec(file.name);
      if (!m) continue;
      const version = `${Number(m[2])}.${Number(m[3])}.${Number(m[4])}`;
      const known = out.get(version);
      if (known && known.folder > m[1]) continue;
      out.set(version, {
        folder: m[1],
        volume: { url: `https://archive.org/download/${item}/${file.name}`, size: Number(file.size ?? 0) },
      });
    }
  }
  return [...out]
    .map(([version, { volume }]) => ({ version, volume }))
    .sort((a, b) => compareVersions(b.version, a.version));
}
