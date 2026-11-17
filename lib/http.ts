// The CDN drops a connection now and then (EPIPE, socket resets) in the middle
// of a multi-gigabyte extraction. A dropped range is not a reason to lose an
// hour of work, so every request retries with a widening delay.
const ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === ATTEMPTS) break;
      await sleep(BASE_DELAY_MS * attempt * attempt);
    }
  }
  throw new Error(`${what} failed after ${ATTEMPTS} attempts: ${last}`);
}

export function fetchText(url: string): Promise<string> {
  return withRetry(url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  });
}

// **A connection can also die without saying so.** The socket closes and
// nothing errors: `arrayBuffer()` waits forever, and a run sat at 0% CPU for two
// hours on a range of `halloween-part1.pkg` with the socket already CLOSED. A
// range is up to a whole block, a gigabyte at a time, so a deadline on the
// request would cut slow but healthy transfers. What is bounded instead is the
// silence: no byte for this long and the attempt is abandoned, which hands it to
// the retry above like any other drop.
const IDLE_MS = 60_000;

export function fetchRange(url: string, range?: string): Promise<Buffer> {
  return withRetry(url, async () => {
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_MS / 1000}s`)), IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_MS / 1000}s`)), IDLE_MS);
    };
    try {
      const res = await fetch(url, {
        signal: abort.signal,
        ...(range ? { headers: { Range: `bytes=${range}` } } : {}),
      });
      if (!res.ok && res.status !== 206) throw new Error(`${res.status} ${url}`);
      if (!res.body) return Buffer.from(await res.arrayBuffer());
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.body) {
        touch();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(idle);
    }
  });
}
