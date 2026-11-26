"""Pull entries out of a remote, solid 7-Zip archive without storing it.

The old clients the Internet Archive preserves are single solid 7z files of up
to ten gigabytes, one LZMA2 stream for the whole install. A solid stream cannot
be entered in the middle, so the sparse trick `lib/archive.ts` plays on the
update CDN's per-package blocks does not apply. What does apply is that the
stream is ordered and that what we want sits early in it: the arena
definitions are within the first megabyte and the localization within the
first few hundred, ahead of gigabytes of vehicles and GUI. So the stream is
decoded as it arrives and abandoned once the last wanted entry is complete.

One connection to the Archive is a few hundred KB/s and they add up, so the
stream is fetched as ordered ranges over many connections at once.

    stream_7z.py list URL             -> JSON lines: {"path", "size", "modified"}
    stream_7z.py extract URL OUT RE   -> writes matching entries under OUT
"""
import concurrent.futures as cf
import json
import lzma
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

CHUNK = 8 << 20
WORKERS = 24
# The end header is normally compressed itself, its packed stream sitting just
# before it, so a generous tail is read rather than the header alone.
TAIL = 8 << 20


def get(url, start, end, attempts=8):
    err = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            if len(data) == end - start + 1:
                return data
            err = f"short read {len(data)}"
        except Exception as e:  # noqa: BLE001 - every failure is retried alike
            err = e
        time.sleep(1 + i * i)
    raise RuntimeError(f"range {start}-{end} of {url} failed: {err}")


def resolve(url):
    """Follow the Archive's redirect to the storage node once, and size the file."""
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.geturl(), int(r.headers["Content-Length"])


def header(url, size):
    """`7z l -slt` of the archive, from a sparse copy holding only its headers,
    and where the packed stream ends."""
    head = get(url, 0, 31)
    next_offset = struct.unpack("<Q", head[12:20])[0]
    packed_end = 32 + next_offset
    start = max(32, size - TAIL)
    tail = get(url, start, size - 1)
    fd, path = tempfile.mkstemp(suffix=".7z")
    with os.fdopen(fd, "wb") as f:
        f.truncate(size)
        f.write(head)
        f.seek(start)
        f.write(tail)
    try:
        listing = subprocess.run(
            ["7z", "l", "-slt", path], capture_output=True, text=True, check=False
        ).stdout
    finally:
        os.unlink(path)
    return listing, packed_end


def entries_of(listing):
    """Stored entries in stream order, each with the block it is in, plus the
    LZMA2 dictionary size and each block's packed size.

    A solid archive may hold several blocks (folders), laid one after the other
    from byte 32. `7z l -slt` credits a block's whole packed size to its first
    entry, which is how the offset of every block is recovered."""
    out = []
    packed = {}
    for block in listing.split("\n\n"):
        path = re.search(r"^Path = (.*)$", block, re.M)
        size = re.search(r"^Size = (\d+)$", block, re.M)
        folder = re.search(r"^Block = (\d+)$", block, re.M)
        if not path or not size or re.search(r"^Folder = \+", block, re.M):
            continue
        # The archive's own record and the empty files carry no block: neither
        # occupies a byte of the stream.
        if folder is None:
            continue
        number = int(folder.group(1))
        size_packed = re.search(r"^Packed Size = (\d+)$", block, re.M)
        if size_packed and number not in packed:
            packed[number] = int(size_packed.group(1))
        modified = re.search(r"^Modified = (.*)$", block, re.M)
        out.append(
            {
                "path": path.group(1),
                "size": int(size.group(1)),
                "block": number,
                "modified": modified.group(1) if modified else None,
            }
        )
    method = re.search(r"^Method = LZMA2:(\d+)(m?)", listing, re.M)
    if method is None:
        raise SystemExit("not an LZMA2 archive")
    value = int(method.group(1))
    dict_size = value << 20 if method.group(2) else 1 << value
    return out, dict_size, packed


def stream_block(url, start, end, entries, targets, out_dir, dict_size):
    """Decode one block from `start`, writing the target entries, and stop as
    soon as the last of them is complete."""
    starts, cum = [], 0
    for e in entries:
        starts.append(cum)
        cum += e["size"]
    last = max(targets)
    end_needed = starts[last] + entries[last]["size"]
    decoder = lzma.LZMADecompressor(
        format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_LZMA2, "dict_size": dict_size}]
    )
    offsets = list(range(start, end, CHUNK))
    index, pos, handle, read = 0, 0, None, 0
    began = time.time()
    with cf.ThreadPoolExecutor(WORKERS) as pool:
        pending = {}
        queued = 0

        def refill():
            nonlocal queued
            while queued < len(offsets) and len(pending) < WORKERS * 2:
                o = offsets[queued]
                pending[queued] = pool.submit(get, url, o, min(o + CHUNK, end) - 1)
                queued += 1

        taken = 0
        refill()
        while pos < end_needed:
            chunk = pending.pop(taken).result()
            taken += 1
            refill()
            read += len(chunk)
            data = decoder.decompress(chunk)
            off = 0
            while off < len(data) and index <= last:
                entry = entries[index]
                take = min(starts[index] + entry["size"] - pos, len(data) - off)
                if index in targets:
                    if handle is None:
                        dest = os.path.join(out_dir, entry["path"])
                        os.makedirs(os.path.dirname(dest), exist_ok=True)
                        handle = open(dest, "wb")
                    handle.write(data[off : off + take])
                off += take
                pos += take
                if pos == starts[index] + entry["size"]:
                    if handle is not None:
                        handle.close()
                        handle = None
                    index += 1
            if taken % 32 == 0:
                rate = read / (time.time() - began) / 1e6
                print(f"  {read / 1e6:.0f} MB read ({rate:.1f} MB/s), {pos / 1e6:.0f}/{end_needed / 1e6:.0f} MB", flush=True)
        for future in pending.values():
            future.cancel()
    return read


def extract(url, out_dir, pattern):
    url, size = resolve(url)
    listing, packed_end = header(url, size)
    entries, dict_size, packed = entries_of(listing)
    want = re.compile(pattern)
    blocks = sorted({e["block"] for e in entries})
    offsets, cursor = {}, 32
    for number in blocks:
        offsets[number] = cursor
        cursor += packed.get(number, 0)
    began, read, found = time.time(), 0, 0
    for number in blocks:
        mine = [e for e in entries if e["block"] == number]
        targets = {i for i, e in enumerate(mine) if want.search(e["path"])}
        if not targets:
            continue
        found += len(targets)
        end = offsets[number] + packed[number] if number in packed else packed_end
        read += stream_block(url, offsets[number], end, mine, targets, out_dir, dict_size)
    if not found:
        print("nothing matches", flush=True)
        return
    print(f"done: {found} entries, {read / 1e6:.0f} MB in {time.time() - began:.0f}s", flush=True)


def main():
    mode, url = sys.argv[1], sys.argv[2]
    if mode == "list":
        url, size = resolve(url)
        listing, _ = header(url, size)
        for entry in entries_of(listing)[0]:
            print(json.dumps(entry))
    elif mode == "extract":
        extract(url, sys.argv[3], sys.argv[4])
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
