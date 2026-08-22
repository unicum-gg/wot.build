"""Convert the client's gettext .mo catalogues into the .po files the mirror ships.

GNU msgunfmt gets within a few bytes but wraps long strings differently: it
breaks after the space, polib breaks before it, and polib is what matches.
"""
import os
import sys

import polib


def main(root, out_root):
    converted = 0
    for base, _, files in os.walk(root):
        for name in files:
            if not name.endswith(".mo"):
                continue
            src = os.path.join(base, name)
            rel = os.path.relpath(src, root)[: -len(".mo")] + ".po"
            dst = os.path.join(out_root, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(str(polib.mofile(src)))
            converted += 1
    print("converted %d catalogues" % converted)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
