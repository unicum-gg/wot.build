// When each update shipped, as Wargaming dates it.
//
// The archive has to order its versions and say when each one was current, and
// only some of its sources carry a usable date: an archived client's files are
// stamped with the build, but the decompiled mirror covering 0.9.12 to 1.12 was
// pushed in one go in September 2018, so every one of its commits reads 2018.
// The publisher's own update history names a month for every update from 8.11
// to today, which is the one date that is the same for every source.
import { fetchText } from "./http.js";

const PAGE = "https://worldoftanks.eu/en/content/docs/release_notes/";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Game version (`0.9.10`, `1.0.2`) -> the first day of the month it shipped
 * (`2015-09-01`). The page writes the pre-1.0 updates without their leading
 * zero ("Update 9.10"), which is read back onto the three-part form the
 * mirrors use.
 */
export async function releaseMonths(): Promise<Map<string, string>> {
  const html = await fetchText(PAGE);
  const out = new Map<string, string>();
  const heading = /<h3>(?:<strong>)?\s*Update\s+(\d+(?:\.\d+)+)[^<(]*\(([A-Za-z]+)\s+(\d{4})\)/g;
  for (const [, raw, month, year] of html.matchAll(heading)) {
    const index = MONTHS.indexOf(month.toLowerCase());
    if (index === -1) continue;
    const parts = raw.split(".").map(Number);
    const full = parts[0] >= 5 && parts[0] < 100 ? [0, ...parts] : parts;
    while (full.length < 3) full.push(0);
    const version = full.slice(0, 3).join(".");
    // The page lists newest first, so a point release (9.15.1) is met before
    // the update it belongs to (9.15) and the later write is the one kept: a
    // version is dated by when it first shipped.
    out.set(version, `${year}-${String(index + 1).padStart(2, "0")}-01`);
  }
  return out;
}

// The publisher's page starts at 8.11. The years before it were dated by its own
// wiki, which is gone (it redirects to the game's front page) and survives on the
// Wayback Machine, one page per year with the same "Update 8.2 / December 2012"
// shape.
const WIKI_YEARS = [2011, 2012, 2013];
const wikiYear = (year: number) =>
  `https://web.archive.org/web/2020id_/https://wiki.wargaming.net/en/Update_${year}`;

/** The same mapping read off the archived wiki, for the updates before 8.11. */
export async function archivedWikiMonths(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const year of WIKI_YEARS) {
    let html: string;
    try {
      html = await fetchText(wikiYear(year));
    } catch {
      continue;
    }
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const heading = /Update (\d+\.\d+(?:\.\d+)?) ([A-Za-z]+) (\d{4})/g;
    for (const [, raw, month, y] of text.matchAll(heading)) {
      const index = MONTHS.indexOf(month.toLowerCase());
      if (index === -1) continue;
      const parts = raw.split(".").map(Number);
      const full = [0, ...parts];
      while (full.length < 3) full.push(0);
      out.set(full.slice(0, 3).join("."), `${y}-${String(index + 1).padStart(2, "0")}-01`);
    }
  }
  return out;
}
