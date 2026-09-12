// Putting what was just published into the CDN, so that no reader is the one
// who pays to get it there.
//
// **What a cold file costs is not its bytes, it is the trip to fetch it.** A
// file nobody has asked for yet is not on the CDN at all, so the first request
// for it travels on to GitHub and back before anything is drawn: measured 1.6
// to 2.2 seconds against 0.12 once it is in place. A vehicle is thirty files,
// which is why the reader who opens a tank first after a rebuild waits five
// seconds where everyone after them waits one.
//
// **One request serves the whole world.** The layer that holds it is a shield
// shared by every edge rather than a cache per city: warmed from Vienna, a file
// answered a request from Paris in 0.13 s where its untouched neighbour took
// 1.63. So one pass from anywhere is the whole job, and it does not have to be
// repeated per region.
//
// **And it moves almost nothing.** `Range: bytes=0-0` pulls the entire object
// into the shield while returning a single byte, so the catalogue is warmed
// with a few megabytes rather than the seven gigabytes it puts in place. That
// is also the version that is kinder to jsDelivr than asking for every file
// whole, since their bandwidth is spent either way but ours is not.

/** What one pass did, and what it could not reach. */
export type Warmed = {
  /** Files the CDN answered for. */
  ok: number;
  /** Those it did not, which stay cold rather than break anything. */
  missed: string[];
  seconds: number;
};

/**
 * How many requests are in flight at once.
 *
 * **Found by pushing until it broke rather than read off a page.** The terms
 * set no limit on the number of requests, so the real ceiling is where the
 * shield starts shedding load: at a hundred in flight it answered 5 in 2000
 * with `503 backend read error`, at fifty it answered all of them. A 503 only
 * means that file stays cold, so this is not about correctness, it is about not
 * being the reason someone else's request fails.
 */
export const WIDTH = 32;

/** How long one file is given before it is counted as missed. */
const PATIENCE = 60_000;

/**
 * Ask for one byte of a file, so the CDN fetches all of it.
 *
 * The body is read rather than dropped: an unread response holds its connection
 * until the runtime collects it, and a few hundred of those in flight starves
 * the pool that the rest of the pass is waiting on.
 */
async function touch(url: string): Promise<boolean> {
  try {
    const answer = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(PATIENCE),
    });
    await answer.arrayBuffer();
    return answer.ok;
  } catch {
    return false;
  }
}

/** Run `work` over `items`, `width` of them at a time. */
async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await work(items[i]);
    }),
  );
}

/**
 * Warm every path under `root`, and say what is still cold afterwards.
 *
 * **Retried once, because a miss here is not a failure of the mirror.** The
 * shield sheds load under a burst and answers 503, which leaves that one file
 * exactly as cold as it was: nothing is broken, one reader will pay for it. A
 * second, narrower pass over what missed costs seconds and takes most of them.
 */
export async function warm(
  root: string,
  paths: string[],
  { width = WIDTH, log }: { width?: number; log?: (message: string) => void } = {},
): Promise<Warmed> {
  const started = Date.now();
  const missed: string[] = [];
  let done = 0;
  const sweep = async (list: string[], at: number, into: string[]) => {
    await pool(list, at, async (path) => {
      if (!(await touch(`${root}/${path}`))) into.push(path);
      done++;
      // Often enough to see it moving on a pass of an hour, rarely enough that
      // the log of a run nobody reads stays short.
      if (log && done % 2000 === 0) {
        log(`  ${done}/${paths.length} in ${Math.round((Date.now() - started) / 1000)}s`);
      }
    });
  };
  await sweep(paths, width, missed);
  if (missed.length > 0) {
    const again = missed.splice(0, missed.length);
    log?.(`  retrying ${again.length}`);
    await sweep(again, Math.max(4, Math.floor(width / 4)), missed);
  }
  return { ok: paths.length - missed.length, missed, seconds: (Date.now() - started) / 1000 };
}

/**
 * The order to warm in: what a page opens on, then what it can be switched to.
 *
 * The hero opens on the standard set and the high-definition one is a toggle,
 * so warming them in that order means a pass that is cut short has still
 * covered every reader who never touches the switch. Within each half the
 * order is the catalogue's own, which puts a vehicle's files together.
 */
export function warmingOrder(paths: string[]): string[] {
  const sharp = (at: string) => at.endsWith("_hd.webp");
  return [...paths.filter((at) => !sharp(at)).sort(), ...paths.filter(sharp).sort()];
}
