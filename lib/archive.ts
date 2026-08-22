// The install volumes are a split 7-Zip whose entries are each their own LZMA2
// block. Rather than download tens of gigabytes, we recreate the volumes as
// SPARSE local files, fill in only the 7z header so `7z l` can enumerate the
// blocks, then range-download just the blocks we actually want.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fetchRange } from "./http.js";
import type { Volume } from "./wgus.js";

export type Block = { name: string; offset: number; packed: number };

const HEADER_HEAD = 64 * 1024; // packed-header stream at the front
const HEADER_TAIL = 2 * 1024 * 1024; // end signature + encoded header

const volumePath = (dir: string, index: number) =>
  path.join(dir, `a.7z.${String(index + 1).padStart(3, "0")}`);

function locate(offset: number, sizes: number[]): { volume: number; local: number } {
  let base = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (offset < base + sizes[i]) return { volume: i, local: offset - base };
    base += sizes[i];
  }
  throw new Error("offset past end of archive");
}

export class SparseArchive {
  private constructor(
    readonly dir: string,
    private readonly volumes: Volume[],
    private readonly sizes: number[],
  ) {}

  static async open(dir: string, volumes: Volume[]): Promise<SparseArchive> {
    const sizes = volumes.map((v) => v.size);
    for (let i = 0; i < volumes.length; i++) {
      const fd = fs.openSync(volumePath(dir, i), "w");
      fs.ftruncateSync(fd, sizes[i]);
      fs.closeSync(fd);
    }
    const archive = new SparseArchive(dir, volumes, sizes);
    const total = sizes.reduce((a, b) => a + b, 0);
    await archive.fill(0, Math.min(HEADER_HEAD, sizes[0]));
    const tail = Math.min(HEADER_TAIL, sizes[sizes.length - 1]);
    await archive.fill(total - tail, tail);
    return archive;
  }

  /** Download `length` bytes at `start` into the sparse volumes. */
  async fill(start: number, length: number): Promise<void> {
    let cursor = start;
    let remaining = length;
    while (remaining > 0) {
      const { volume, local } = locate(cursor, this.sizes);
      const take = Math.min(remaining, this.sizes[volume] - local);
      const buf = await fetchRange(this.volumes[volume].url, `${local}-${local + take - 1}`);
      const fd = fs.openSync(volumePath(this.dir, volume), "r+");
      fs.writeSync(fd, buf, 0, buf.length, local);
      fs.closeSync(fd);
      cursor += take;
      remaining -= take;
    }
  }

  /**
   * Release everything downloaded so far, keeping the archive usable.
   *
   * Filling a block writes its bytes into the sparse volumes and they stay
   * there, so walking every package would eventually materialise the whole
   * multi-gigabyte part on disk. Truncating back to zero punches all of it out;
   * only the ~2 MB header has to be fetched again.
   */
  async reset(): Promise<void> {
    for (let i = 0; i < this.volumes.length; i++) {
      const file = volumePath(this.dir, i);
      const fd = fs.openSync(file, "r+");
      fs.ftruncateSync(fd, 0);
      fs.ftruncateSync(fd, this.sizes[i]);
      fs.closeSync(fd);
    }
    const total = this.sizes.reduce((a, b) => a + b, 0);
    await this.fill(0, Math.min(HEADER_HEAD, this.sizes[0]));
    const tail = Math.min(HEADER_TAIL, this.sizes[this.sizes.length - 1]);
    await this.fill(total - tail, tail);
  }

  /**
   * Every entry with its byte offset. Blocks are non-solid and laid out in
   * listing order starting at 32, which has been verified against real CRCs.
   */
  index(): Map<string, Block> {
    const listing = execFileSync("7z", ["l", "-slt", volumePath(this.dir, 0)], {
      encoding: "utf8",
      maxBuffer: 512 << 20,
    });
    const blocks = new Map<string, Block>();
    let offset = 32;
    for (const entry of listing.split(/\r?\n\r?\n/)) {
      const name = (entry.match(/^Path = (.+)$/m) ?? [])[1];
      if (!name || !/^Packed Size =/m.test(entry)) continue; // header or directory
      const packed = Number((entry.match(/^Packed Size = (\d+)$/m) ?? [])[1] ?? "0");
      blocks.set(name, { name, offset, packed });
      offset += packed;
    }
    return blocks;
  }

  /** Range-download one block and unpack it into `destination`. */
  async extract(block: Block, destination: string): Promise<string> {
    await this.fill(block.offset, block.packed);
    execFileSync(
      "7z",
      ["x", volumePath(this.dir, 0), `-i!${block.name}`, `-o${destination}`, "-y"],
      { stdio: "ignore" },
    );
    return path.join(destination, block.name);
  }
}
