# wot.build

Builds the World of Tanks mirrors from Wargaming's and Lesta's update CDNs, with
no game client installed. This repository holds the machinery; the output lives
in four content repositories, one branch per client build.

| Mirror | What it publishes | Branches |
| --- | --- | --- |
| [`wot.src`](https://github.com/unicum-gg/wot.src) | decompiled client sources | EU, NA, ASIA, CT, RU, PT_RU, CN |
| [`wot.assets`](https://github.com/unicum-gg/wot.assets) | the client's `gui` tree | WG, WG_CT, Lesta, Lesta_PT |
| [`wot.maps`](https://github.com/unicum-gg/wot.maps) | HD battle minimaps | WG, WG_CT, Lesta, Lesta_PT |
| [`wot.models`](https://github.com/unicum-gg/wot.models) | vehicle armor and visual geometry | WG, WG_CT, Lesta, Lesta_PT |

The first three were each a fork of someone else's mirror, fast-forwarded from
upstream. Every one of those upstreams had gone stale on its test branch, so a
Common Test vehicle had no sources, no icon and no minimap anywhere. They are now
built from the client itself. `wot.models` has no upstream at all: the mirrors
that publish a vehicle's scripts all leave its meshes out, because they are
binary, which is what stops a site from drawing a tank.

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
- `generate-models.ts`: a vehicle's **armor**, read out of the Havok collision
  files as named plates, and its **visual model**, converted from BigWorld
  geometry to glTF with its textures as WebP, plus three files at the root: the
  2D style catalogue, published once rather than beside every vehicle, the index
  saying which vehicles exist and under which nation folder, and `worn.json`,
  naming the 3D style a vehicle is issued already wearing

  That last one is what makes a reward vehicle look like itself. Most of them
  ship no geometry at all: the Monkey King is a 121B plus a style the game will
  not let its owner take off, so the index points it at the 121B and without the
  style it is drawn as one. Those model sets are pulled by default, and only
  those, since 237 vehicles declare 330 between them and the rest are
  alternatives a player chooses. `--skins` pulls the lot.

The sources mirror does the opposite of the assets one and **empties its
worktree first**: a script the client dropped must stop being published, because
that tree describes what the game is.

The models generator is the only one that reads more than one package family: a
vehicle's pieces are split across its tier's `-partN` packages, and the textures
a nation shares between its vehicles live in the `shared_content` ones instead.
It converts each package as it sweeps it and keeps only the output, because
holding them all at once would mean twenty gigabytes on disk.

**It also only redoes what moved.** Wargaming publishes no patch to read: asked
for a part's chain, WGUS answers with one link, the whole install, 15.84 GB for
the release branch's `sdcontent`. So a new build says nothing about what changed
inside it. The archive does, in the header the sweep already downloads to
enumerate its blocks: every package carries a checksum, and those are published
as `packages.json` beside the mirror. A run compares them and leaves an unchanged
package entirely alone, which means not downloaded, not extracted and not
converted. What that turns into is a run measured in the packages a patch really
touched rather than in the whole client, and it is why the root files
(`vehicles.json`, `based-on.json`, `styles2d.json`) are written from the state of
the mirror rather than from what the run happened to rebuild: written from the
run, an index naming three vehicles would tell a reader the other 1400 do not
exist. `patterns.json` is kept for the same reason, since a pattern's pixel size
is measured as it is converted and a style resolved without it is published at
the wrong scale.

`--force` ignores both guards, the version and the checksums, and is what to
pass right after changing the generator itself: the output would differ where
neither the version nor any package has.

## Running one locally

Needs `7z`, `xdelta3`, `rdiff`, a JRE, and Python 3.9 with `uncompyle6`/`polib`.

```sh
npm install
npm run sources -- --host wgus-woteu.wargaming.net --guid WOT.EU.PRODUCTION --out out
npm run assets  -- --host wgus-wotct.wargaming.net --guid WOT.CT.PRODUCTION --out out
npm run maps    -- --host wgus-woteu.wargaming.net --guid WOT.EU.PRODUCTION --out out --all
npm run models  -- --host wgus-woteu.wargaming.net --guid WOT.EU.PRODUCTION --out out
```

`--force` re-extracts even when the client version is unchanged. The models
generator also takes `--vehicle CODE` and `--package NAME[,NAME]` to narrow a run
down to something that finishes in a minute, and `--collision-only` to skip the
visual half.

## Notice

Assets provided in the mirrors are the property of their sole owners.
