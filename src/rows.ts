/**
 * Synthetic render load for the benchmark, carried as `?rows=N`.
 *
 * Omitted from the search params entirely when it is 0, so the demo's own
 * URLs stay clean and only a benchmark run carries the parameter.
 */
export type RowsSearch = { rows?: number }

export const validateRows = (search: Record<string, unknown>): RowsSearch => {
  const rows = Number(search.rows)
  if (!Number.isFinite(rows) || rows <= 0) return {}
  return { rows: Math.min(Math.floor(rows), 20000) }
}
