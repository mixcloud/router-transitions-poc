import { useEffect, useState } from 'react'

/**
 * Patches `document.startViewTransition` once and renders a running count, so
 * the demo shows whether a view transition actually ran — no devtools needed.
 */
export function TransitionCounter() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const doc = document as Document & {
      __vtPatched?: boolean
      __vtListeners?: Set<() => void>
    }

    doc.__vtListeners ??= new Set()
    const listeners = doc.__vtListeners
    const bump = () => setCount((c) => c + 1)
    listeners.add(bump)

    if (!doc.__vtPatched && typeof doc.startViewTransition === 'function') {
      doc.__vtPatched = true
      const original = doc.startViewTransition.bind(doc)
      doc.startViewTransition = ((...args: Array<never>) => {
        listeners.forEach((fn) => fn())
        return original(...args)
      }) as typeof doc.startViewTransition
    }

    return () => {
      listeners.delete(bump)
    }
  }, [])

  return (
    <div className="vt-counter">
      view transitions fired: <strong>{count}</strong>
    </div>
  )
}
