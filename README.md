# router-transitions-poc

Minimal reproduction: React's `<ViewTransition>` never fires across a TanStack
Router navigation, because router state reaches the tree through
`useSyncExternalStore`.

Two routes — a hard-coded list of five news articles, and a detail page. The
cover image in the list and the hero image on the detail page are wrapped in
the same `<ViewTransition name="article-image-{id}">`, which should give a
shared-element morph between them.

**Expected:** the cover image morphs into the hero image.
**Actual:** no view transition runs at all; the route swaps in one synchronous
commit and the image jumps.

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
`.npmrc` sets `legacy-peer-deps=true` — TanStack's peer range
(`>=18.0.0 || >=19.0.0`) rejects prerelease versions.

## Reproducing

```bash
npm install
npm run dev
```

Chromium-based browser required; `<ViewTransition>` is built on the native
View Transition API.

The badge in the bottom-right counts real calls to
`document.startViewTransition`. Three interactions on the list page:

| Interaction | View transitions fired |
| --- | --- |
| React state + `startTransition` (layout toggle) | **1** — animates |
| `router.navigate()` inside `startTransition` | **0** |
| `<Link>` navigation (any article card) | **0** |

The first row is the control, and it is the important one: the same
`<ViewTransition>` elements, the same names, the same browser, the same React
build. Only the trigger differs. So this is not a browser support problem, a
missing `name`, or a mis-paired old/new element.

`scripts/verify-transitions.mjs` measures the same three numbers headlessly:

```bash
npm run dev                      # in one terminal
npm install --no-save playwright
npx playwright install chromium  # once
node scripts/verify-transitions.mjs   # BASE=... to override port
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

The consequence for this POC: the update carrying the new route is never on a
transition lane, and `<ViewTransition>` only fires for transition updates. So
it never runs.

This is structural. Any router that publishes its state through
`useSyncExternalStore` is unable to drive React's `<ViewTransition>`,
regardless of how the navigation is triggered.

## What this POC is *not* about

`<Link viewTransition>` and `router.navigate({ viewTransition: true })` do
produce an animation, but they call `document.startViewTransition` directly.
That is the platform API, limited to CSS `view-transition-name`. It does not
go through React's `<ViewTransition>`, so it does not compose with transition
types, nested transition scoping, or React's own old/new pairing. This
reproduction is specifically about React's `<ViewTransition>`.

A fix is out of scope here — this repo exists to demonstrate the failure and
to have something to measure a fix against.

## Layout

```
src/routes/__root.tsx        shell + the view-transition counter badge
src/routes/index.tsx         news list, both control buttons
src/routes/article.$id.tsx   detail page, big hero image
src/ViewTransition.tsx       typed re-export of the canary API
src/data/articles.ts         the five hard-coded articles
scripts/verify-transitions.mjs  headless measurement of the table above
```
