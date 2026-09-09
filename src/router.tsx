import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Opt in to the patched render-frame protocol. Without this the patch is
 * inert and navigations behave exactly as they do on stock TanStack Router.
 *
 * `VITE_CONCURRENT_FRAMES=0` builds the control, so `scripts/benchmark-inp.mjs`
 * can compare two builds of identical source. Unset means enabled, which is
 * what the demo ships.
 */
const CONCURRENT_RENDER_FRAMES = import.meta.env.VITE_CONCURRENT_FRAMES !== "0";

export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    experimental_concurrentRenderFrames: CONCURRENT_RENDER_FRAMES,
  });

  // `scripts/benchmark-inp.mjs` reads the mode straight off the live router
  // rather than trusting which port it connected to. Nothing else in the
  // stack populates this global, so the benchmark's arm check depends on it.
  //
  // `__BUILD_ID__` is the other half of that check. The experiment's premise
  // is that both arms are builds of *identical source*, and a `--strictPort`
  // preview server that was already running serves whatever it was started
  // with — a stale build the arm check would still accept, because the mode
  // is right. Stamping the build lets the benchmark refuse two arms that did
  // not come from the same source.
  if (typeof window !== "undefined") {
    const win = window as unknown as {
      __TSR_ROUTER__?: unknown;
      __BUILD_ID__?: string | null;
    };
    win.__TSR_ROUTER__ = router;
    win.__BUILD_ID__ = import.meta.env.VITE_BUILD_ID ?? null;
  }

  return router;
}
