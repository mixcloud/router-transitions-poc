import * as React from 'react'

/**
 * `<ViewTransition>` only exists in the React canary/experimental channel, and
 * `@types/react` (which tracks stable) does not declare it yet. Cast it once
 * here so the rest of the app can use it with real types.
 */
export type ViewTransitionProps = {
  name?: string
  children?: React.ReactNode
  default?: string
  enter?: string
  exit?: string
  update?: string
  share?: string
}

export const ViewTransition = (
  React as unknown as {
    ViewTransition: React.ComponentType<ViewTransitionProps>
  }
).ViewTransition

export const supportsViewTransition = typeof ViewTransition !== 'undefined'
