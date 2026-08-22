"""Decompile every .pyc under a tree into .py, the way the mirror publishes them.

uncompyle6 prints a provenance header and a trailing "# okay decompiling" line,
and its files end without a newline. Version matters: 3.8.0 is what reproduces
IzeBerg/wot-src byte for byte, later releases mangle nested dict comprehensions.
"""
import contextlib
import io
import multiprocessing
import os
import sys

from uncompyle6.main import decompile_file


def strip(text):
    lines = text.split("\n")
    start = 0
    while start < len(lines) and lines[start].startswith("#"):
        start += 1
    body = [l for l in lines[start:] if not l.startswith("# okay decompiling")]
    return "\n".join(body).rstrip("\n")


# A handful of modules defeat the decompiler. Upstream still publishes them:
# whatever was recovered, with this marker appended (and nothing else when the
# very first statement already failed). The marker carries no trailing newline.
FAILED_MARKER = "# Decompile failed :("


def one(job):
    src, dst = job
    buf = io.StringIO()
    failed = None
    try:
        # uncompyle6 dumps the offending bytecode listing on stderr when it
        # gives up; the marker in the file already records that.
        with contextlib.redirect_stderr(io.StringIO()):
            decompile_file(src, buf)
        text = strip(buf.getvalue())
    except Exception as exc:
        # Keep the partial output, exactly as the uncompyle6 CLI does.
        text = strip(buf.getvalue()) + FAILED_MARKER
        failed = "%s: %s" % (src, exc)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write(text)
    return failed


def main(root, out_root):
    jobs = []
    for base, _, files in os.walk(root):
        for name in files:
            if not name.endswith(".pyc"):
                continue
            src = os.path.join(base, name)
            rel = os.path.relpath(src, root)[: -len(".pyc")] + ".py"
            jobs.append((src, os.path.join(out_root, rel)))

    with multiprocessing.Pool() as pool:
        failures = [f for f in pool.imap_unordered(one, jobs, chunksize=8) if f]

    print("decompiled %d/%d (%d marked as failed)" % (len(jobs), len(jobs), len(failures)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
