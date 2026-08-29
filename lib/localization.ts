// The names players actually see.
//
// Everything in the customization data names itself with a key, never with a
// name: a style reads `#vehicle_customization:special_style/pub_west_streamer`,
// and a viewer showing that is showing an internal identifier. The names live
// in the client's message catalogue, which the packages ship compiled and our
// own mirror of the client sources ships as plain gettext.
//
// So this reads the mirror rather than the packages. It is the same source the
// map catalogue already takes its arena names from, it is infrastructure we
// control, and it costs one request against unpacking a compiled catalogue out
// of a 600 MB package. A key the mirror does not carry falls back to itself, so
// a branch lagging the client build shows an untranslated name rather than
// nothing.
import { fetchText } from "./http.js";

const MIRROR = "https://raw.githubusercontent.com/unicum-gg/wot.src";

/**
 * One catalogue, as `key -> name`.
 *
 * A `.po` entry is a `msgid` line followed by a `msgstr` line, both quoted. The
 * client writes one per line rather than using gettext's continuation form, so
 * the pair is all there is to read.
 */
export async function readCatalogue(name: string, branch = "EU"): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const body = await fetchText(`${MIRROR}/${branch}/sources/res/text/lc_messages/${name}.po`);
  const entry = /msgid\s+"((?:[^"\\]|\\.)*)"\s*\r?\nmsgstr\s+"((?:[^"\\]|\\.)*)"/g;
  for (const [, key, value] of body.matchAll(entry)) {
    if (key && value) out.set(unescape(key), unescape(value));
  }
  return out;
}

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/**
 * The name behind a client key, or the key's own last part when the catalogue
 * has nothing for it.
 *
 * A key reads `#vehicle_customization:special_style/aquino`: the part before
 * the colon is the catalogue it lives in and the rest is the entry.
 */
export function nameFor(key: string, catalogue: Map<string, string>): string {
  const entry = key.startsWith("#") ? key.slice(1).split(":").slice(1).join(":") : key;
  return catalogue.get(entry) ?? entry.split("/").pop() ?? key;
}
