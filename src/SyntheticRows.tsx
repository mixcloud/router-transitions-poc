/**
 * Synthetic render load for `scripts/benchmark-inp.mjs`.
 *
 * The demo's real routes are far too small to show a scheduling difference —
 * they render in under a millisecond. `?rows=N` gives the destination route a
 * controllable amount of honest React reconciliation work, so the benchmark
 * can measure how interaction latency responds to route render cost.
 */
export function SyntheticRows({ rows }: { rows: number }) {
  if (rows <= 0) return null

  return (
    <div className="synthetic" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="synthetic-row" key={i}>
          <span className="synthetic-index">{i}</span>
          <span className="synthetic-label">
            {`row ${i} · ${(i * 2654435761) % 100000}`}
          </span>
          <span className="synthetic-bar" style={{ width: `${i % 97}px` }} />
        </div>
      ))}
    </div>
  )
}
