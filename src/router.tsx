import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * Opt in to the patched render-frame protocol. Without this the patch is
 * inert and navigations behave exactly as they do on stock TanStack Router.
 *
 * `VITE_CONCURRENT_FRAMES=0` builds the control, so `scripts/benchmark-inp.mjs`
 * can compare two builds of identical source. Unset means enabled, which is
 * what the demo ships.
 */
const CONCURRENT_RENDER_FRAMES =
  import.meta.env.VITE_CONCURRENT_FRAMES !== '0'

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    experimental_concurrentRenderFrames: CONCURRENT_RENDER_FRAMES,
  })
}
