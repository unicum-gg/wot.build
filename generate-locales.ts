// Publishes the game's own words, in every language it is played in.
//
// Wargaming translates World of Tanks itself: a map, a game mode, a nation and
// a badge already have a name in each language the client ships, and it is the
// name a player reads in their own game. The public API only serves thirteen of
// them, and its `encyclopedia/arenas` has been empty for years, so the maps are
// not in it at all. The client is where they live.
//
// The launcher's own mechanism is the whole trick: the locale part is served
// per language, so the same build answers with `..._locale_fr.wgpkg` when asked
// for FR. Each package is around 43 MB and one catalogue inside it is a few
// kilobytes, which the sparse-archive reader downloads on its own.
//
// This is a union across clients rather than a per-branch tree: EU ships the
// twenty-four European languages, Asia the five Asian ones, NA the two American
// Spanish and Portuguese, and China its own Chinese. No single branch has them
// all, so they are published together on `LOCALES` and the first client to
// carry a language wins it.
//
// Usage: npm run generate:locales -- --out DIR [--catalogues a,b] [--only LANG]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SparseArchive } from "./lib/archive.js";
import { resolveClient } from "./lib/wgus.js";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const OUT = path.resolve(flag("--out") ?? "out");
const PYTHON = process.env.WOTSRC_PYTHON ?? "python3";
/**
 * The catalogues published per language. Deliberately a short list rather than
 * the whole locale part: it holds 296 catalogues and about 540 KB of `.po` per
 * language, which across thirty languages would rewrite 12 MB of branch on every
 * build for words nothing reads. Adding one here is a word, and the names in it
 * are still the client's rather than ours.
 *
 * The seven here are the ones the site reads by key, and each was measured
 * against the French client before being added rather than assumed:
 * `arenas` names every map and every battle type (`type/comp7/name` is how we
 * know Onslaught is "Offensive" in French); `artefacts` the equipment,
 * consumables, directives and field modifications (96% translated);
 * `crew_perks` the crew skills (97%); `veh_skill_tree` the tier XI upgrades
 * (97%); `menu` the characteristics themselves, whose 265 `tank_params/` keys
 * are the vocabulary of a tank's stat table; and `comp7.comp7_ext` the Onslaught
 * season names, which exist nowhere else (the event board serves only dates, so
 * "Season of the Azure Phoenix" is a client string); and `profile`, the
 * vocabulary of the client's own player profile, which is what our profile page
 * is a version of, so the game already has a word for most of what it says
 * ("Achievements" is "Faits d'armes" in French, not a translation anyone would
 * reach for).
 *
 * Deliberately NOT here: the `<nation>_vehicles` catalogues. A tank's name is a
 * proper noun and Wargaming does not translate it (9 of 1,638 differ in French,
 * none of them a real translation, and 0 of 492 module names), so mirroring
 * 60 KB a nation a language would buy nothing. Their `_descr`/`_special` blurbs
 * ARE translated, and are the one thing worth revisiting if the site starts
 * showing them.
 */
const CATALOGUES = (flag("--catalogues") ?? "arenas,artefacts,crew_perks,veh_skill_tree,menu,comp7.comp7_ext,profile")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);
const ONLY = flag("--only")?.toUpperCase();

/**
 * The clients to draw from, in the order they claim a language. EU leads
 * because it ships the most and because English should come from the same
 * build as the rest of Europe.
 *
 * Lesta's two (`MT.RU`, `MT.PT`) are deliberately absent even though `generate`
 * mirrors them. They ship a 330-byte locale part, since Мир танков is
 * Russian-only and its catalogues travel with the client rather than beside it,
 * and Russian already comes from the EU build here. Their game has diverged from
 * World of Tanks anyway, so their wording would not be the wording our readers
 * see.
 */
const CLIENTS = [
  { name: "EU", host: "wgus-woteu.wargaming.net", guid: "WOT.EU.PRODUCTION" },
  { name: "ASIA", host: "wgus-wotasia.wargaming.net", guid: "WOT.ASIA.PRODUCTION" },
  { name: "NA", host: "wgus-wotna.wargaming.net", guid: "WOT.NA.PRODUCTION" },
  { name: "CN", host: "wgus-cn360.wggames.cn", guid: "WOT.CN.PRODUCTION" },
] as const;

const log = (message: string) => console.log(`[wot.src locales] ${message}`);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wotsrc-locales-"));

/** Pull the configured catalogues of one language out of its locale package. */
async function harvestLanguage(
  client: { getChain: (part: string) => { volumes: { url: string; size: number }[] }[] },
  language: string,
): Promise<boolean> {
  const chain = client.getChain("locale");
  if (chain.length === 0) return false;
  const dir = path.join(workDir, language);
  fs.mkdirSync(dir, { recursive: true });
  const archive = await SparseArchive.open(dir, chain[0].volumes);
  const blocks = [...archive.index().values()].filter((block) => {
    const base = (block.name.split(/[/\\]/).pop() ?? "").toLowerCase();
    return base.endsWith(".mo") && CATALOGUES.includes(base.slice(0, -3));
  });
  if (blocks.length === 0) {
    log(`${language}: none of ${CATALOGUES.join(", ")} in the locale part`);
    return false;
  }
  const moDir = path.join(dir, "mo");
  for (const block of blocks) await archive.extract(block, moDir);

  const source = path.join(moDir, "res", "text", "lc_messages");
  if (!fs.existsSync(source)) return false;
  const target = path.join(OUT, "text", "lc_messages", language.toLowerCase());
  fs.mkdirSync(target, { recursive: true });
  execFileSync(PYTHON, [path.resolve("lib/py/mo_to_po.py"), source, target], {
    stdio: "inherit",
  });
  // The sparse volumes are as large as the package they stand in for, and
  // thirty of those at once is more disk than a runner has.
  fs.rmSync(dir, { recursive: true, force: true });
  log(`${language}: ${blocks.length} catalogue(s)`);
  return true;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const written = new Map<string, string>();
  const versions: Record<string, string> = {};

  for (const entry of CLIENTS) {
    // A client that is briefly unpublished must not take the others down with
    // it: the languages it owns keep whatever the last run left on the branch.
    let languages: string[];
    try {
      const probe = await resolveClient(entry.host, entry.guid);
      if (!probe) {
        log(`${entry.name}: no build published`);
        continue;
      }
      languages = probe.languages;
      versions[entry.name] = probe.versionName;
    } catch (error) {
      console.error(`[wot.src locales] ${entry.name}: ${String(error)}`);
      continue;
    }
    log(`${entry.name} ${versions[entry.name]} ships ${languages.join(", ")}`);

    for (const language of languages) {
      if (written.has(language)) continue;
      if (ONLY && language !== ONLY) continue;
      try {
        // Resolved per language: the chain names a different package for each,
        // and that is the only place the language appears.
        const client = await resolveClient(entry.host, entry.guid, language);
        if (!client) continue;
        if (await harvestLanguage(client, language)) written.set(language, entry.name);
      } catch (error) {
        console.error(`[wot.src locales] ${entry.name}/${language}: ${String(error)}`);
      }
    }
  }

  const readme = [
    "# LOCALES",
    "",
    "The World of Tanks client's own gettext catalogues, one directory per",
    "language, harvested from the update CDN. Generated by",
    "[`generate-locales.ts`](../../blob/main/generate-locales.ts); edits made",
    "against this branch would be overwritten by the next build.",
    "",
    `Catalogues published: ${CATALOGUES.map((c) => `\`${c}\``).join(", ")}.`,
    "",
    "| Language | Client |",
    "| --- | --- |",
    ...[...written].map(([language, client]) => `| \`${language.toLowerCase()}\` | ${client} |`),
    "",
    "Client versions: " +
      Object.entries(versions)
        .map(([name, version]) => `${name} ${version}`)
        .join(", ") +
      ".",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "README.md"), readme);
  fs.writeFileSync(
    path.join(OUT, ".versions.json"),
    JSON.stringify(versions, null, 2) + "\n",
  );

  fs.rmSync(workDir, { recursive: true, force: true });
  log(`done: ${written.size} language(s) in ${OUT}`);
}

main().catch((error) => {
  console.error("[wot.src locales] failed:", error);
  process.exit(1);
});
