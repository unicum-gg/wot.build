// Generator for the `unicum-gg/wot.maps` mirror: the HD battle minimaps, pulled
// from the client on the update CDN with no game installed.
//
// A minimap is a DXT surface at `spaces/<id>/mmap.dds` inside that map's own
// package, so one map costs one range-downloaded block rather than the whole
// multi-gigabyte part. Variants live beside it under the same `mmap` prefix and
// publish as `<id><variant>.webp`, which is why some ids yield several files:
// the Onslaught night play area (`mmap_comp7.dds`), and on the maps with random
// events one layer per event, both the area it strikes and the ground it leaves.
//
// It also cuts the minimap markers (bases, spawns, control points) out of the
// client's battle atlas, taken from the sibling `wot.assets` mirror since that
// one already publishes the `gui` tree.
//
// Usage: npm run maps -- --host H --guid G --out DIR [--all|--id X] [--force]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { SparseArchive, type Block } from "./lib/archive.js";
import { decodeDDS, ddsInnerToWebp } from "./lib/dds.js";
import { fetchText, fetchRange } from "./lib/http.js";
import { resolveClient } from "./lib/wgus.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

const HOST = flag("--host") ?? "wgus-woteu.wargaming.net";
const GUID = flag("--guid") ?? "WOT.EU.PRODUCTION";
const OUT = path.resolve(flag("--out") ?? "maps-out");
const SIZE = Number(flag("--size") ?? "2048");
const ONLY = flag("--id");
const PART = flag("--part");
const FORCE = args.includes("--force");
const ALL = args.includes("--all");
// The markers are cut from the assets mirror, not from the client, so how they
// are rendered can change while every published minimap stays valid. This
// republishes that set alone, in seconds, instead of paying a full `--force`
// re-extraction of every map to ship one new marker.
const MARKERS_ONLY = args.includes("--markers");

// A map lives in exactly one content part; `client` wins for the rare id in both.
const PARTS = PART ? [PART] : ["client", "sdcontent"];

// Packages that never hold a `spaces/<id>/mmap.dds`: skipping them keeps `--all`
// from range-downloading tens of megabytes per tank/shared/hangar block.
const NON_MAP = /(?:^|[/_-])(?:vehicles_level|shared_content|hangar)|_bin$|_editor/;

// The markers are sprites inside the client's battle atlas, which `wot.assets`
// already publishes, so they are read from there rather than re-extracted here.
//
// Two atlases, live first: a marker for a mode still in testing exists only in
// the test client's atlas (the Onslaught illumination-flare point is in the
// test one and not the live one), and the published set is a single region
// agnostic folder, so a sprite the live atlas does not have is taken from the
// test one rather than left out. The test atlas is only fetched when the live
// one is missing a sprite.
const ATLAS_REFS = ["WG", "WG_CT"];
const atlasUrl = (ref: string) =>
  `https://raw.githubusercontent.com/unicum-gg/wot.assets/${ref}/gui/flash/atlases/battleAtlas`;
const MARKER_SCALE = 2; // 64px atlas sprites -> crisp 128px PNGs

const log = (msg: string) => console.log(`[wot.maps] ${msg}`);

/** A sprite's box inside the atlas sheet. */
type Rect = { x: number; y: number; w: number; h: number };

/** Map id -> its package block, for every map in this part. */
function mapPackages(archive: SparseArchive): Map<string, Block> {
  const out = new Map<string, Block>();
  for (const block of archive.index().values()) {
    const m = /^res\/packages\/([^/]+)\.pkg$/.exec(block.name);
    if (m && !NON_MAP.test(m[1])) out.set(m[1], block);
  }
  return out;
}

/**
 * Every minimap a map package ships, as inner paths.
 *
 * They are listed off the package rather than named here, so a variant a patch
 * adds is mirrored by the next run instead of by the next code change. That is
 * how the random-event layers arrived: the maps already carried them, and only
 * the two hardcoded names kept them out.
 */
function innerMinimaps(pkg: string, id: string): string[] {
  const listing = execFileSync("7z", ["l", "-slt", pkg], {
    encoding: "utf8",
    maxBuffer: 128 << 20,
  });
  const wanted = new RegExp(`^spaces/${id}/mmap[^/]*\\.dds$`);
  const found: string[] = [];
  for (const entry of listing.split(/\r?\n\r?\n/)) {
    const name = (entry.match(/^Path = (.+)$/m) ?? [])[1]?.replace(/\\/g, "/");
    if (name && wanted.test(name)) found.push(name);
  }
  return found.sort();
}

async function extractMap(archive: SparseArchive, block: Block, id: string): Promise<void> {
  const work = path.join(archive.dir, "pkg");
  fs.rmSync(work, { recursive: true, force: true });
  const pkg = await archive.extract(block, work);
  const mapsDir = path.join(OUT, "maps");
  fs.mkdirSync(mapsDir, { recursive: true });
  const inners = innerMinimaps(pkg, id);
  if (!inners.includes(`spaces/${id}/mmap.dds`)) throw new Error(`no minimap in ${id}`);
  for (const inner of inners) {
    const variant = inner.slice(`spaces/${id}/mmap`.length, -".dds".length);
    try {
      await ddsInnerToWebp(archive.dir, pkg, inner,
        path.join(mapsDir, `${id}${variant}.webp`), variant === "", SIZE);
    } catch (error) {
      // The standard minimap is the map; a variant is a bonus, so one the
      // decoder cannot read is reported and skipped rather than costing the map
      // its own mirror entry.
      if (variant === "") throw error;
      log(`  ~ ${id}${variant}: ${(error as Error).message}`);
    }
  }
}
function markerSprites(): Record<string, string> {
  const out: Record<string, string> = {
    base_ally: "AllyTeamBaseEntry_green_0",
    base_enemy: "EnemyTeamBaseEntry_red_0",
    control_point: "ControlPointEntry_0",
  };
  for (let i = 1; i <= 4; i++) {
    out[`spawn_ally_${i}`] = `AllyTeamSpawnEntry_green_${i}`;
    out[`spawn_enemy_${i}`] = `EnemyTeamSpawnEntry_red_${i}`;
  }
  return out;
}

function parseAtlasXml(xml: string): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const re =
    /<SubTexture>\s*<name>\s*([^<\s]+)\s*<\/name>\s*<x>\s*(\d+)\s*<\/x>\s*<y>\s*(\d+)\s*<\/y>\s*<width>\s*(\d+)\s*<\/width>\s*<height>\s*(\d+)\s*<\/height>/g;
  for (const m of xml.matchAll(re)) {
    rects.set(m[1], { x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
  }
  return rects;
}

/** One decoded atlas sheet plus the sprite boxes it declares. */
type Atlas = { rects: Map<string, Rect>; width: number; height: number; rgba: Buffer };

/** A sprite together with the sheet it was found on. */
type Sprite = { atlas: Atlas; rect: Rect };

async function loadAtlas(ref: string): Promise<Atlas> {
  const url = atlasUrl(ref);
  const [xml, dds] = await Promise.all([
    fetchText(`${url}.xml`),
    fetchRange(`${url}.dds`),
  ]);
  const { width, height, rgba } = decodeDDS(dds);
  return { rects: parseAtlasXml(xml), width, height, rgba };
}

async function generateMarkers(): Promise<void> {
  console.log("[wot.maps] extracting minimap markers from battleAtlas...");
  const loaded = new Map<string, Atlas>();
  const atlasFor = async (ref: string): Promise<Atlas> => {
    const hit = loaded.get(ref);
    if (hit) return hit;
    const atlas = await loadAtlas(ref);
    loaded.set(ref, atlas);
    return atlas;
  };
  // First atlas that declares the sprite, live before test.
  const find = async (name: string): Promise<Sprite | null> => {
    for (const ref of ATLAS_REFS) {
      const atlas = await atlasFor(ref);
      const rect = atlas.rects.get(name);
      if (rect) return { atlas, rect };
    }
    return null;
  };
  const markersDir = path.join(OUT, "markers");
  fs.mkdirSync(markersDir, { recursive: true });
  let ok = 0;
  const missing: string[] = [];
  for (const [name, sprite] of Object.entries(markerSprites())) {
    const found = await find(sprite);
    if (!found) {
      missing.push(sprite);
      continue;
    }
    const { atlas, rect: r } = found;
    await sharp(atlas.rgba, {
      raw: { width: atlas.width, height: atlas.height, channels: 4 },
    })
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
      .resize(r.w * MARKER_SCALE, r.h * MARKER_SCALE, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toFile(path.join(markersDir, `${name}.png`));
    ok++;
  }

  // Onslaught points-of-interest markers: the `poiMarkerBack` disc (a neutral,
  // semi-transparent scrim the game colours per state) + a per-type glyph
  // (`poiMarkerIcon_{type}`, the client's own `POI_CONSTS`: 1 = artillery
  // strike, 2 = recon, 3 = illumination flare). We render the game's
  // "available/capturable" look: a solid white disc with the glyph darkened for
  // contrast, rather than the greyed-out captured state.
  const crop = ({ atlas, rect: r }: Sprite) =>
    sharp(atlas.rgba, {
      raw: { width: atlas.width, height: atlas.height, channels: 4 },
    })
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
      .resize(r.w * MARKER_SCALE, r.h * MARKER_SCALE, { kernel: "lanczos3" });
  // Recolour a sprite: fill `rgb`, keep its shape, and boost its alpha (the disc
  // is only ~half opaque) so the fill reads solid.
  const recolour = async (
    s: Sprite,
    rgb: { r: number; g: number; b: number },
    alphaGain: number,
  ): Promise<Buffer> => {
    const alpha = await crop(s).extractChannel(3).linear(alphaGain, 0).png().toBuffer();
    return sharp({
      create: {
        width: s.rect.w * MARKER_SCALE,
        height: s.rect.h * MARKER_SCALE,
        channels: 3,
        background: rgb,
      },
    })
      .joinChannel(alpha)
      .png()
      .toBuffer();
  };
  const poiIcons: Record<string, string> = {
    poi_strike: "poiMarkerIcon_1",
    poi_recon: "poiMarkerIcon_2",
    poi_flare: "poiMarkerIcon_3",
  };
  // A soft dark shadow of a sprite, so a white glyph stays legible on the white
  // disc (an all-white marker that still reads).
  const shadow = async (s: Sprite): Promise<Buffer> => {
    const alpha = await crop(s).extractChannel(3).png().toBuffer();
    return sharp({
      create: {
        width: s.rect.w * MARKER_SCALE,
        height: s.rect.h * MARKER_SCALE,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .joinChannel(alpha)
      .blur(2)
      .png()
      .toBuffer();
  };
  // The same sprite on a given sheet, so a glyph and its disc are always cut
  // from one atlas rather than mixing a live disc with a test glyph.
  const sameSheet = (s: Sprite, name: string): Sprite | null => {
    const rect = s.atlas.rects.get(name);
    return rect ? { atlas: s.atlas, rect } : null;
  };
  for (const [name, iconName] of Object.entries(poiIcons)) {
    const icon = await find(iconName);
    const back = icon
      ? (sameSheet(icon, "poiMarkerBack") ?? (await find("poiMarkerBack")))
      : null;
    if (!back || !icon) {
      missing.push(name);
      continue;
    }
    const disc = await recolour(back, { r: 0xff, g: 0xff, b: 0xff }, 3);
    const glyph = await recolour(icon, { r: 0xff, g: 0xff, b: 0xff }, 1.2);
    await sharp(disc)
      .composite([
        { input: await shadow(icon), gravity: "center" },
        { input: glyph, gravity: "center" },
      ])
      .png({ compressionLevel: 9 })
      .toFile(path.join(markersDir, `${name}.png`));
    ok++;
  }

  console.log(
    `[wot.maps] markers: ${ok} written to ${markersDir}${missing.length ? `, missing: ${missing.join(", ")}` : ""}`,
  );
}
async function main(): Promise<void> {
  if (MARKERS_ONLY) {
    await generateMarkers();
    return;
  }
  log(`resolving ${GUID} via ${HOST}`);
  const client = await resolveClient(HOST, GUID);
  if (!client) {
    log(`${GUID}: no build published, nothing to mirror`);
    return;
  }
  log(`client ${client.versionName} (host ${client.host})`);

  const versionFile = path.join(OUT, ".version_name");
  const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : null;
  if (current === client.versionName && !FORCE) {
    log(`already at ${client.versionName}, nothing to do`);
    return;
  }

  const opened: SparseArchive[] = [];
  const byId = new Map<string, { archive: SparseArchive; block: Block }>();
  try {
    for (const part of PARTS) {
      const chain = client.getChain(part);
      if (chain.length === 0) {
        log(`no ${part} volumes, skipping`);
        continue;
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotmaps-"));
      const archive = await SparseArchive.open(dir, chain[0].volumes);
      opened.push(archive);
      const packages = mapPackages(archive);
      for (const [id, block] of packages) if (!byId.has(id)) byId.set(id, { archive, block });
      log(`${part}: ${packages.size} map packages`);
    }

    const ids = ONLY ? [ONLY] : ALL ? [...byId.keys()] : ["01_karelia"];
    let ok = 0;
    const missing: string[] = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        missing.push(id);
        continue;
      }
      try {
        await extractMap(entry.archive, entry.block, id);
        ok++;
        log(`  ${id} (${(entry.block.packed / 1e6).toFixed(1)} MB block)`);
        // Drop the block: walking every map would otherwise materialise the
        // whole part on disk.
        await entry.archive.reset();
      } catch (e) {
        missing.push(id);
        log(`  ! ${id}: ${(e as Error).message}`);
      }
    }

    await generateMarkers();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(versionFile, `${client.versionName}\n`);
    log(`done: ${ok} maps, ${missing.length} missing`);
  } finally {
    for (const a of opened) fs.rmSync(a.dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
