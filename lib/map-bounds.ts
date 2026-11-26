// The play area of a map at a given version: the extent its minimap covers,
// which is what an overlay drawn in world metres has to be fitted to.
//
// Read from that version's arena definition on our `wot.src` mirror, so a map
// whose bounds Wargaming moved between two updates is drawn against the right
// ones. The first `<boundingBox>` of a definition is the map's own; the ones
// after it belong to its gameplay types.
import { DEFS, mirrorVersions, SRC_REPO } from "./archive-catalog.js";
import { fetchText } from "./http.js";
import type { Bounds } from "./map-diff.js";

let shas: Promise<Map<string, string>> | null = null;
const known = new Map<string, Bounds | null>();

export function parseBounds(xml: string): Bounds | null {
  const m = /<boundingBox>\s*<bottomLeft>\s*(-?[\d.]+)\s+(-?[\d.]+)[\s\S]*?<\/bottomLeft>\s*<upperRight>\s*(-?[\d.]+)\s+(-?[\d.]+)/.exec(xml);
  if (!m) return null;
  const [x0, z0, x1, z1] = m.slice(1).map(Number);
  return x1 > x0 && z1 > z0 ? { x0, z0, x1, z1 } : null;
}

export async function boundsAt(id: string, version: string): Promise<Bounds | null> {
  const key = `${id}@${version}`;
  if (known.has(key)) return known.get(key)!;
  shas ??= mirrorVersions().then((list) => new Map(list.map((v) => [v.version, v.sha])));
  const sha = (await shas).get(version);
  let bounds: Bounds | null = null;
  if (sha) {
    try {
      bounds = parseBounds(await fetchText(`https://raw.githubusercontent.com/${SRC_REPO}/${sha}/${DEFS}/${id}.xml`));
    } catch {
      bounds = null;
    }
  }
  known.set(key, bounds);
  return bounds;
}
