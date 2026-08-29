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
- transition callbacks return the assembled state, so partial publication is a
  type error;
- a `RouterStateProvider` owns the committed frame in ordinary React state,
  stages a successor inside `startTransition`, and commits it on
  acknowledgement;
- `Matches` acknowledges the exact rendered `frameId`, so a superseded
  navigation cannot settle a newer one;
- selector hooks read a *stable* owner context and subscribe to it, and the
  owner notifies subscribers from inside that same `startTransition`.

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

- That branch is TanStack Router `main` at `0caf6b9`, which is **ahead of the
  published `1.170.32`** by unreleased upstream commits. So the patches also
  carry those — currently
  [#8169](https://github.com/TanStack/router/pull/8169), a fix to route-scoped
  hooks. They are not part of the render-frame change.
- Source maps are left untouched, so stepping through the patched packages in
  devtools will show stale mappings. The shipped code is correct; only the maps
  are.

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
patches/                     the two pnpm patches
scripts/verify-transitions.mjs  headless measurement of the table above
```
