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

export function fetchRange(url: string, range?: string): Promise<Buffer> {
  return withRetry(url, async () => {
    const res = await fetch(url, range ? { headers: { Range: `bytes=${range}` } } : {});
    if (!res.ok && res.status !== 206) throw new Error(`${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
  });
}
