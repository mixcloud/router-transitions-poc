import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    // Opt in to the patched render-frame protocol. Without this the patch is
    // inert and navigations behave exactly as they do on stock TanStack Router.
    experimental_concurrentRenderFrames: true,
  })
}
