import { useEffect, useState } from "react";

/**
 * Patches `document.startViewTransition` once and renders a running count, so
 * the demo shows whether a view transition actually ran — no devtools needed.
 */
export function TransitionCounter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const doc = document as Document & {
      __vtPatched?: boolean;
      __vtListeners?: Set<() => void>;
    };

    doc.__vtListeners ??= new Set();
    const listeners = doc.__vtListeners;
    const bump = () => setCount((c) => c + 1);
    listeners.add(bump);

    // A window-level tally as well as the rendered count: the benchmark reads
    // `window.__vt` across a navigation to witness that transitions really ran
    // in the arm it thinks it measured. Seeded here so a read before the first
    // transition is 0 rather than undefined.
    const win = window as unknown as { __vt?: number };
    win.__vt ??= 0;

    if (!doc.__vtPatched && typeof doc.startViewTransition === "function") {
      doc.__vtPatched = true;
      const original = doc.startViewTransition.bind(doc);
      doc.startViewTransition = ((...args: Array<never>) => {
        win.__vt = (win.__vt ?? 0) + 1;
        listeners.forEach((fn) => fn());
        return original(...args);
      }) as typeof doc.startViewTransition;
    }

    return () => {
      listeners.delete(bump);
    };
  }, []);

  return (
    <div className="vt-counter">
      view transitions fired: <strong>{count}</strong>
    </div>
  );
}
