// Generator for the `unicum-gg/wot.maps` mirror: the HD battle minimaps, pulled
// from the client on the update CDN with no game installed.
//
// A minimap is a DXT surface at `spaces/<id>/mmap.dds` inside that map's own
// package, so one map costs one range-downloaded block rather than the whole
// multi-gigabyte part. The Onslaught night variants live beside it as
// `mmap_comp7.dds`, which is why some ids yield two files.
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

// A map lives in exactly one content part; `client` wins for the rare id in both.
const PARTS = PART ? [PART] : ["client", "sdcontent"];

// Packages that never hold a `spaces/<id>/mmap.dds`: skipping them keeps `--all`
// from range-downloading tens of megabytes per tank/shared/hangar block.
const NON_MAP = /(?:^|[/_-])(?:vehicles_level|shared_content|hangar)|_bin$|_editor/;

// The markers are sprites inside the client's battle atlas, which `wot.assets`
// already publishes, so they are read from there rather than re-extracted here.
const ATLAS =
  "https://raw.githubusercontent.com/unicum-gg/wot.assets/WG/gui/flash/atlases/battleAtlas";
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

async function extractMap(archive: SparseArchive, block: Block, id: string): Promise<void> {
  const work = path.join(archive.dir, "pkg");
  fs.rmSync(work, { recursive: true, force: true });
  const pkg = await archive.extract(block, work);
  const mapsDir = path.join(OUT, "maps");
  fs.mkdirSync(mapsDir, { recursive: true });
  await ddsInnerToWebp(archive.dir, pkg, `spaces/${id}/mmap.dds`,
    path.join(mapsDir, `${id}.webp`), true, SIZE);
  // Onslaught reuses a handful of maps at night; absent for every other id.
  await ddsInnerToWebp(archive.dir, pkg, `spaces/${id}/mmap_comp7.dds`,
    path.join(mapsDir, `${id}_comp7.webp`), false, SIZE);
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

async function generateMarkers(): Promise<void> {
  console.log("[wot.maps] extracting minimap markers from battleAtlas...");
  const [xml, dds] = await Promise.all([
    fetchText(`${ATLAS}.xml`),
    fetchRange(`${ATLAS}.dds`),
  ]);
  const rects = parseAtlasXml(xml);
  const { width, height, rgba } = decodeDDS(dds);
  const markersDir = path.join(OUT, "markers");
  fs.mkdirSync(markersDir, { recursive: true });
  let ok = 0;
  const missing: string[] = [];
  for (const [name, sprite] of Object.entries(markerSprites())) {
    const r = rects.get(sprite);
    if (!r) {
      missing.push(sprite);
      continue;
    }
    await sharp(rgba, { raw: { width, height, channels: 4 } })
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
      .resize(r.w * MARKER_SCALE, r.h * MARKER_SCALE, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toFile(path.join(markersDir, `${name}.png`));
    ok++;
  }

  // Onslaught points-of-interest markers: the `poiMarkerBack` disc (a neutral,
  // semi-transparent scrim the game colours per state) + a per-type glyph
  // (`poiMarkerIcon_{type}`, 1 = strike, 2 = recon). We render the game's
  // "available/capturable" look: a solid white disc with the glyph darkened for
  // contrast, rather than the greyed-out captured state.
  const crop = (r: Rect) =>
    sharp(rgba, { raw: { width, height, channels: 4 } })
      .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
      .resize(r.w * MARKER_SCALE, r.h * MARKER_SCALE, { kernel: "lanczos3" });
  // Recolour a sprite: fill `rgb`, keep its shape, and boost its alpha (the disc
  // is only ~half opaque) so the fill reads solid.
  const recolour = async (
    r: Rect,
    rgb: { r: number; g: number; b: number },
    alphaGain: number,
  ): Promise<Buffer> => {
    const alpha = await crop(r).extractChannel(3).linear(alphaGain, 0).png().toBuffer();
    return sharp({
      create: {
        width: r.w * MARKER_SCALE,
        height: r.h * MARKER_SCALE,
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
  };
  // A soft dark shadow of a sprite, so a white glyph stays legible on the white
  // disc (an all-white marker that still reads).
  const shadow = async (r: Rect): Promise<Buffer> => {
    const alpha = await crop(r).extractChannel(3).png().toBuffer();
    return sharp({
      create: {
        width: r.w * MARKER_SCALE,
        height: r.h * MARKER_SCALE,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .joinChannel(alpha)
      .blur(2)
      .png()
      .toBuffer();
  };
  const back = rects.get("poiMarkerBack");
  for (const [name, iconName] of Object.entries(poiIcons)) {
    const icon = rects.get(iconName);
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
