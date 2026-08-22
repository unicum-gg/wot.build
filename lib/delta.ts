// Incremental patches ship their packages as binary deltas against the version
// already installed. Wargaming uses two off-the-shelf formats, told apart by
// extension, and both have a command-line decoder:
//
//   `.xdiff` -> VCDIFF (RFC 3284), magic `d6 c3 c4`, decoded by xdelta3
//   `.rdiff` -> librsync,          magic `72 73 02 36`, decoded by rdiff
//
// The name also carries a checksum (`scripts.pkg.2.3.1.23962.3AFC1F30.xdiff`)
// but it is not a CRC-32 of either side, so integrity is checked by testing the
// rebuilt archive instead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** `res/packages/scripts.pkg.2.3.1.23962.3AFC1F30.xdiff` -> `res/packages/scripts.pkg`. */
export function deltaTarget(name: string): string | null {
  const m = /^(.*\.pkg)\.[0-9.]+\.[0-9A-F]+\.(xdiff|rdiff)$/i.exec(name);
  return m ? m[1] : null;
}

export const isDelta = (name: string) => deltaTarget(name) !== null;

/**
 * Rebuild `base` + `delta` into `out`.
 *
 * Throws when the decoder refuses the pair, which means the chain was walked out
 * of order: carrying on would publish a half-patched package.
 */
export function applyDelta(base: string, delta: string, out: string): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const kind = path.extname(delta).toLowerCase();
  if (kind === ".xdiff") {
    execFileSync("xdelta3", ["-d", "-f", "-s", base, delta, out], { stdio: ["ignore", "ignore", "pipe"] });
  } else if (kind === ".rdiff") {
    execFileSync("rdiff", ["patch", base, delta, out], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    throw new Error(`unknown delta format ${kind}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error(`${path.basename(delta)} produced nothing`);
  }
}
