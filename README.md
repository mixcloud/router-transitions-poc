# router-transitions-poc

Minimal reproduction of a TanStack Router bug — **with the fix applied**.

React's `<ViewTransition>` never fires across a TanStack Router navigation,
because router state reaches the tree through `useSyncExternalStore`. This
branch patches `@tanstack/react-router` and `@tanstack/router-core` with the
render-frame change proposed in
[mixcloud/router#1](https://github.com/mixcloud/router/pull/1), and turns it on.
The `main` branch of this repo is the same app *without* the patch, and is where
the failure is documented.

Two routes — a hard-coded list of five news articles, and a detail page. The
cover image in the list and the hero image on the detail page are wrapped in
the same `<ViewTransition name="article-image-{id}">`, which should give a
shared-element morph between them.

**Expected:** the cover image morphs into the hero image.
**On `main` (unpatched):** no view transition runs at all; the route swaps in
one synchronous commit and the image jumps.
**Here (patched):** it morphs.

## Versions

| | |
| --- | --- |
| `react` / `react-dom` | `19.3.0-canary-29d9d318-20260826` |
| `@tanstack/react-router` | `1.170.32` |
| `@tanstack/react-start` | `1.168.49` |
| `@tanstack/router-core` | `1.171.27` |
| `@tanstack/react-store` | `0.9.3` |
| `vite` | `8.2.2` |

React is pinned to a canary because that is where `<ViewTransition>` lives.
Note that pnpm is required, not incidental: TanStack's peer range
(`>=18.0.0 || >=19.0.0`) does not match a prerelease under npm's semver rules,
so `npm install` fails on it without `--legacy-peer-deps`. pnpm resolves it
cleanly, even with `--strict-peer-dependencies`.

## Reproducing

```bash
pnpm install
pnpm dev
```

Chromium-based browser required; `<ViewTransition>` is built on the native
View Transition API.

The badge in the bottom-right counts real calls to
`document.startViewTransition`. Three interactions on the list page:

| Interaction | `main` (unpatched) | here (patched) |
| --- | --- | --- |
| React state + `startTransition` (layout toggle) | 1 | **1** |
| `router.navigate()` inside `startTransition` | 0 | **1** |
| `<Link>` navigation (any article card) | 0 | **1** |

The first row is the control: the same `<ViewTransition>` elements, the same
names, the same browser, the same React build, on both branches. Only the
trigger differs — which is what isolated the failure to router navigation
rather than browser support, a missing `name`, or a mis-paired old/new element.

It is a genuine shared-element morph, not merely a transition firing. The
pseudo-elements animating mid-navigation are:

```text
::view-transition-group(article-image-2)
::view-transition-old(article-image-2)
::view-transition-new(article-image-2)
```

`scripts/verify-transitions.mjs` measures the same three numbers headlessly:

```bash
pnpm dev                               # in one terminal
pnpm exec playwright install chromium  # once
pnpm verify                            # BASE=... to override the port
```

## Benchmarking

The transition counter answers "does a transition run". `scripts/benchmark-inp.mjs`
answers the question underneath it: **where does the route render happen relative
to the paint the user is waiting for**, and what that costs in interaction latency
— the per-interaction quantity INP is a high percentile of.

Both arms are builds of *identical source*; only `VITE_CONCURRENT_FRAMES` differs,
so nothing but the router's publication path can account for a difference.

```bash
pnpm exec playwright install chromium        # once

VITE_CONCURRENT_FRAMES=0 pnpm build --outDir dist-control
VITE_CONCURRENT_FRAMES=1 pnpm build --outDir dist-patched
pnpm exec vite preview --outDir dist-control --port 4173 --strictPort &
pnpm exec vite preview --outDir dist-patched --port 4174 --strictPort &

node scripts/benchmark-inp.mjs               # writes benchmark-results.json
```

The demo's own routes render in well under a millisecond, far too little to show
a scheduling difference, so `?rows=N` gives the destination route a controllable
amount of real React reconciliation work (`src/SyntheticRows.tsx`). Sweeping it is
the point: it shows how interaction latency *responds* to route render cost, which
is a claim about mechanism rather than a single number.

### Method

- Blocks alternate control/patched, and alternate which arm goes first, so machine
  drift cannot masquerade as an effect.
- Each block gets a fresh browser context and discards warmup clicks.
- CPU is throttled 6x via CDP, the full Chromium build (not headless-shell) so
  view transitions and paint timing are real.
- Interaction latency is computed the way INP defines it: group Event Timing
  entries by `interactionId`, take the maximum `duration` in each group.
- Two independent witnesses confirm each block ran the build it claims: the mode
  is read straight off the live router (`__TSR_ROUTER__.options`), and the run
  counts real `document.startViewTransition` calls.

Event Timing will not report an interaction shorter than 16ms, and rounds
`duration` to 8ms. An absent entry is therefore a genuine measurement — faster
than the API can see — not a missed sample.

### Results

6x CPU throttle, 8 blocks x 6 measured clicks — 48 navigations per cell.
`vt` counts real `document.startViewTransition` calls, and doubles as the proof
that each arm ran the build it claims.

| `?rows=` | arm | vt | p50 | p95 | max | click frame | blocking |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | control | 0 | 24ms | 32ms | 32ms | — | — |
| 0 | **patched** | 48 | **24ms** | **24ms** | **24ms** | — | — |
| 500 | control | 0 | 56ms | 56ms | 64ms | — | — |
| 500 | **patched** | 48 | **24ms** | **24ms** | **24ms** | — | — |
| 2000 | control | 0 | 136ms | 144ms | 152ms | 117ms | 63ms |
| 2000 | **patched** | 48 | **24ms** | **24ms** | **24ms** | 94ms | 25ms |
| 6000 | control | 0 | 360ms | 456ms | 456ms | 337ms | 284ms |
| 6000 | **patched** | 48 | **24ms** | **24ms** | **24ms** | 279ms | 183ms |

Control tracks route render cost almost linearly. Patched is flat — 24ms at
every weight, p50 through max, including the 6000-row route that costs the
control arm 456ms.

**The patch does not make rendering faster.** The route still renders, and the
frame that renders it is still long (279ms at 6000 rows). What changes is where
that work sits relative to the paint the user is waiting for. Under
`useSyncExternalStore` the render is inside the click's own animation frame, so
nothing can be presented until it finishes; on the frame path the click handler
returns in a couple of milliseconds and the render happens in a later frame.

That distinction is the whole mechanism, and it comes with a condition: the
interaction ends at the *next paint*, so something must actually paint. Here the
view transition guarantees one. An app with neither a view transition nor pending
UI on its navigations has nothing to present, and the interaction stretches to
the commit — see the measurements in
[mixcloud/Mixcloud#25470](https://github.com/mixcloud/Mixcloud/pull/25470),
where that is exactly what happened until a navigation progress bar was added.

## Why it fails

**It is not that navigation forgets to be a transition.** `<Link>` already
routes through React's `startTransition`: `Transitioner.tsx` overrides
`router.startTransition` to call `React.startTransition(fn)`, and
`router-core`'s client loader commits every set of matches through that
override. The second button in this demo wraps `navigate()` in
`startTransition` a second time, redundantly, and behaves identically. Neither
matters, for the reason below.

The problem is *how the state reaches the component tree*. Every router
subscription in `@tanstack/react-router` — `Match`, `Matches`,
`useRouterState`, `useLocation`, `Link` — reads through `useStore` from
`@tanstack/react-store`, which is `useSyncExternalStoreWithSelector`, which is
`useSyncExternalStore`.

React schedules `useSyncExternalStore` updates at a **hardcoded** `SyncLane`,
from inside the store's own subscription callback:

```js
// react-dom, subscribeToStore → forceStoreRerender
function forceStoreRerender(fiber) {
  var root = enqueueConcurrentRenderForLane(fiber, 2); // 2 === SyncLane
  null !== root && scheduleUpdateOnFiber(root, fiber, 2);
}
```

That lane is a constant. It is not derived from the ambient transition
context, and the callback that schedules it runs from the store subscription —
outside the `startTransition` scope entirely, after it has exited. React
does this deliberately: an external store cannot produce a previous snapshot
on demand, so the old and new UI cannot be rendered concurrently without
tearing.

The consequence: the update carrying the new route is never on a transition
lane, and `<ViewTransition>` only fires for transition updates. So it never
runs. This is structural — any router that publishes its state through
`useSyncExternalStore` is unable to drive React's `<ViewTransition>`,
regardless of how the navigation is triggered.

## How the patch fixes it

The patch adds an opt-in router option, `experimental_concurrentRenderFrames`,
which changes *how* router state reaches the tree rather than how navigation is
triggered:

- every aggregate router state carries a monotonic `frameId`;
- a `RouterStateProvider` owns the committed frame, stages a successor inside
  `startTransition`, and commits it on acknowledgement;
- `Matches` acknowledges the exact rendered `frameId`, so a superseded
  navigation cannot settle a newer one;
- selector hooks read a *stable* context and subscribe to it, and the owner
  notifies subscribers from inside that same `startTransition`;
- a staged frame is offered, never imposed: each consumer records in React
  state which frame its own render is presenting, so a work-in-progress render
  can accept the staged frame while the tree still on screen keeps reading the
  committed one.

Because the update reaching each consumer is plain React state set inside
`startTransition`, it keeps its transition lane and `<ViewTransition>` fires.
Because each consumer only re-renders when its own selection changes, the
existing fine-grained selector behaviour is preserved — a consumer whose
selection is unchanged does not re-render during a navigation.

It is enabled in `src/router.tsx`. Set it to `false` and the app reverts to the
`main` behaviour without reinstalling — the patch is inert unless opted in.

## The patches

`patches/` holds two pnpm patches, wired up through `pnpm-workspace.yaml`, so a
plain `pnpm install` reproduces everything:

| Patch | Package |
| --- | --- |
| `@tanstack__react-router@1.170.32.patch` | `@tanstack/react-router` |
| `@tanstack__router-core@1.171.27.patch` | `@tanstack/router-core` |

They replace `dist/` and `src/` with a build of
[`mixcloud/router@concurrent-router-render-frames`](https://github.com/mixcloud/router/tree/concurrent-router-render-frames).
Two caveats worth knowing:

- That branch is TanStack Router `main` (currently `b88367ccf9`), which is **ahead of the
  published `1.170.32`** by unreleased upstream commits. So the patches also
  carry those — currently
  [#8169](https://github.com/TanStack/router/pull/8169), a fix to route-scoped
  hooks. They are not part of the render-frame change.
- Source maps are left untouched, so stepping through the patched packages in
  devtools will show stale mappings. The shipped code is correct; only the maps
  are. Regenerate with `pnpm patch <pkg>`, copy `dist/` and `src/` from the
  router build over the edit directory, `pnpm patch-commit`, then drop the
  `*.map` sections — they add an order of magnitude to the patch and tell a
  reviewer nothing.
- The patches are byte-identical to the ones in
  [mixcloud/Mixcloud#25470](https://github.com/mixcloud/Mixcloud/pull/25470),
  so both repos exercise the same router build.

## What this POC is *not* about

`<Link viewTransition>` and `router.navigate({ viewTransition: true })` do
produce an animation, but they call `document.startViewTransition` directly.
That is the platform API, limited to CSS `view-transition-name`. It does not
go through React's `<ViewTransition>`, so it does not compose with transition
types, nested transition scoping, or React's own old/new pairing. This
reproduction is specifically about React's `<ViewTransition>`.

The patch here is about React's `<ViewTransition>` specifically; it does not
change `viewTransition: true`, which keeps working as before.

## Layout

```text
src/routes/__root.tsx        shell + the view-transition counter badge
src/routes/index.tsx         news list, both control buttons
src/routes/article.$id.tsx   detail page, big hero image
src/ViewTransition.tsx       typed re-export of the canary API
src/data/articles.ts         the five hard-coded articles
src/router.tsx               where experimental_concurrentRenderFrames is set
src/SyntheticRows.tsx        controllable render load for the benchmark
src/rows.ts                  the ?rows=N search param
patches/                     the two pnpm patches
scripts/verify-transitions.mjs  headless measurement of the table above
scripts/benchmark-inp.mjs       interaction latency vs route render cost
```
