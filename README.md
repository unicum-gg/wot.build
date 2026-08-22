# wot.build

Builds the World of Tanks mirrors from Wargaming's and Lesta's update CDNs, with
no game client installed. This repository holds the machinery; the output lives
in three content repositories, one branch per client build.

| Mirror | What it publishes | Branches |
| --- | --- | --- |
| [`wot.src`](https://github.com/unicum-gg/wot.src) | decompiled client sources | EU, NA, ASIA, CT, RU, PT_RU, CN |
| [`wot.assets`](https://github.com/unicum-gg/wot.assets) | the client's `gui` tree | WG, WG_CT, Lesta, Lesta_PT |
| [`wot.maps`](https://github.com/unicum-gg/wot.maps) | HD battle minimaps | WG, WG_CT, Lesta, Lesta_PT |

They were each a fork of someone else's mirror, fast-forwarded from upstream.
Every one of those upstreams had gone stale on its test branch, so a Common Test
vehicle had no sources, no icon and no minimap anywhere. All three are now built
from the client itself.

## Why one repository

The three generators share the hard part: resolving a branch through WGUS to the
CDN URLs of its install volumes, rebuilding those split 7-Zip volumes as **sparse**
files so a single package can be range-downloaded out of a 13 GB archive, and
replaying the incremental patches over it. That code lived twice and drifted:
when WGUS started answering the Common Test with a `redirect_url`, the fix had to
be written once per mirror, and the second one was missed for weeks.

Here it exists once, in `lib/`, and each generator is only what makes it
different.

## The generators

- `generate-sources.ts`: `.pyc` decompiled, packed XML converted to text, `.swc`
  decompiled to ActionScript, gettext `.mo` to `.po`
- `generate-assets.ts`: the `gui` tree, **accumulating**: it writes over its
  branch without clearing, because Wargaming pulls an event's art when the event
  ends and no later client returns it
- `generate-maps.ts`: `spaces/<id>/mmap.dds` decoded from DXT to webp, plus the
  minimap markers cut out of the client's battle atlas

The sources mirror does the opposite of the assets one and **empties its
worktree first**: a script the client dropped must stop being published, because
that tree describes what the game is.

## Running one locally

Needs `7z`, `xdelta3`, `rdiff`, a JRE, and Python 3.9 with `uncompyle6`/`polib`.

```sh
npm install
npm run sources -- --host wgus-woteu.wargaming.net --guid WOT.EU.PRODUCTION --out out
npm run assets  -- --host wgus-wotct.wargaming.net --guid WOT.CT.PRODUCTION --out out
npm run maps    -- --host wgus-woteu.wargaming.net --guid WOT.EU.PRODUCTION --out out --all
```

`--force` re-extracts even when the client version is unchanged.

## Notice

Assets provided in the mirrors are the property of their sole owners.
