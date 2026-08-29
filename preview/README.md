# preview

The pipeline's own viewer: what a generated vehicle actually looks like, drawn
from exactly the files the mirror publishes and nothing else. It is how a change
anywhere in the conversion gets judged, since a texture channel read the wrong
way round is not something a type checker can see.

Three pages, all plain HTML with no build step. `three` comes from an import map
rather than a bundler, so a page is opened and that is the whole setup.

| Page | What it draws |
| --- | --- |
| `live.html` | A vehicle, its collision, and the shell that goes through it. Carries the 2D style, the marks of excellence and the track. |
| `vehicle.html` | The visual model alone, for looking at geometry without the rest. |

## Running it

Serve this folder over HTTP and point `models` at a generated tree, since a
module script cannot be loaded from `file://`:

```sh
ln -s /path/to/models-out preview/models
npx serve preview -l 8123
open 'http://127.0.0.1:8123/live.html?view=visual&v=russian/R45_IS-7'
```

`v` is the vehicle's nation and code as the mirror lays them out, and `view` is
`live`, `collision` or `visual`.

## Where this is going

The viewer is destined for the site, where it becomes a React component rather
than a page. It is kept here because it belongs to the pipeline: it reads the
mirror's own layout, and it has to keep working whether or not the site does.
