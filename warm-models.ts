// Warms the CDN for a branch of the `unicum-gg/wot.models` mirror, so the first
// reader after a rebuild is not the one who waits for it.
//
// **It has to run on every rebuild, not only on the ones that changed much.**
// A viewer reads the mirror at a URL pinned to the commit, which is what buys a
// year of caching instead of five minutes. The other half of that bargain is
// that a new commit is a new address for every file in the branch, including
// the ones whose bytes did not move, so the whole catalogue goes cold at once
// however small the patch was.
//
// It is also worth running when nothing changed at all. The shield evicts what
// nobody asks for, so a nightly pass over an unchanged branch puts back
// whatever fell out of it during the week, and costs a minute: a file already
// there answers in a tenth of the time it takes to fetch one that is not.
//
// Usage: npm run warm -- --branch WG [--branch WG_CT] [--width N] [--from DIR]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warm, warmingOrder, WIDTH } from "./lib/warm.js";

const REPO = "unicum-gg/wot.models";
const CDN = "https://cdn.jsdelivr.net/gh";

const args = process.argv.slice(2);
const log = (message: string) => console.log(`[wot.warm] ${message}`);

function flags(name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i !== -1; i = args.indexOf(name)) {
    const value = args[i + 1];
    args.splice(i, 2);
    if (value) out.push(value);
  }
  return out;
}

/**
 * The commit a branch points at, which is the address a reader is served.
 *
 * Resolved here rather than warming `@<branch>`: the site pins to the commit,
 * so warming the branch URL would fill the shield under an address nobody
 * requests and leave every real one cold.
 */
async function headOf(branch: string): Promise<string> {
  const answer = await fetch(`https://api.github.com/repos/${REPO}/commits/${branch}`, {
    headers: {
      accept: "application/vnd.github.sha",
      // Anonymous is 60 requests an hour and this asks for one per branch, but
      // a runner shares its address with everyone else on it.
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!answer.ok) throw new Error(`${branch}: ${answer.status}`);
  return (await answer.text()).trim();
}

/** Every file on a branch, without downloading any of them. */
function filesOf(branch: string): string[] {
  // A blobless clone brings the tree and none of the content, which is seconds
  // and a few megabytes against the twenty gigabytes the branch holds.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotwarm-"));
  try {
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", "--branch", branch, `https://github.com/${REPO}.git`, dir],
      { stdio: "ignore" },
    );
    return execFileSync("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The same list, read off a tree already on disk, which the generator leaves. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

async function main(): Promise<void> {
  const branches = flags("--branch");
  const from = flags("--from")[0];
  const width = Number(flags("--width")[0] ?? WIDTH) || WIDTH;
  if (branches.length === 0) throw new Error("--branch is required");

  let cold = 0;
  for (const branch of branches) {
    const sha = await headOf(branch);
    const paths = warmingOrder(from ? filesUnder(from) : filesOf(branch));
    log(`${branch} at ${sha.slice(0, 12)}: ${paths.length} files, ${width} at a time`);
    const { ok, missed, seconds } = await warm(`${CDN}/${REPO}@${sha}`, paths, { width, log });
    log(`${branch}: ${ok}/${paths.length} warm in ${Math.round(seconds)}s`);
    if (missed.length > 0) {
      // Named rather than counted, so a run that leaves a whole nation cold
      // does not read the same as one that lost a handful to a blip.
      log(`${branch}: ${missed.length} still cold, first few: ${missed.slice(0, 5).join(", ")}`);
      cold += missed.length;
    }
  }
  // **Never a failure.** A file that stayed cold is a file one reader waits a
  // second longer for, and this runs at the end of a job that has already
  // spent five hours publishing the mirror. Failing here would colour that red
  // for something nobody needs to act on.
  if (cold > 0) log(`${cold} files left cold, which costs a reader a wait and nothing else`);
}

main().catch((e) => {
  log(`failed: ${(e as Error).message}`);
});
