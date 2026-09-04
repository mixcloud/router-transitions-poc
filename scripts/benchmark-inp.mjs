/**
 * Measures interaction latency — the quantity INP is a high percentile of —
 * for a client-side route navigation, with and without the render-frame patch,
 * across a sweep of route render costs (`?rows=N`).
 *
 * The two servers must be builds of *identical source*; only
 * VITE_CONCURRENT_FRAMES differs. See README "Benchmarking" for the commands.
 *
 *   CONTROL=http://localhost:4173 PATCHED=http://localhost:4174 \
 *     ROWS=0,500,2000,6000 node scripts/benchmark-inp.mjs
 *
 * Blocks alternate control/patched, and alternate which arm goes first, so
 * machine drift cannot masquerade as an effect. Each block gets a fresh
 * browser context and discards warmup clicks.
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const CONTROL = process.env.CONTROL ?? 'http://localhost:4173'
const PATCHED = process.env.PATCHED ?? 'http://localhost:4174'
const ROWS = (process.env.ROWS ?? '0,500,2000,6000').split(',').map(Number)
const BLOCKS = Number(process.env.BLOCKS ?? 4)
const CLICKS = Number(process.env.CLICKS ?? 5)
const WARMUP = Number(process.env.WARMUP ?? 2)
const CPU = Number(process.env.CPU ?? 6)
const OUT = process.env.OUT ?? 'benchmark-results.json'

/**
 * Event Timing refuses to report an interaction shorter than 16ms, so an
 * absent entry is itself a measurement — faster than the API can see — rather
 * than a failed one.
 */
const EVENT_TIMING_FLOOR_MS = 16

const observers = () => {
  window.__perf = { events: [], loafs: [] }

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.interactionId > 0) {
        window.__perf.events.push({
          name: e.name,
          interactionId: e.interactionId,
          startTime: e.startTime,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
          duration: e.duration,
        })
      }
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true })

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__perf.loafs.push({
        startTime: e.startTime,
        duration: e.duration,
        renderStart: e.renderStart,
        blockingDuration: e.blockingDuration,
        firstUIEventTimestamp: e.firstUIEventTimestamp,
        scripts: e.scripts.map((s) => ({
          invoker: s.invoker,
          invokerType: s.invokerType,
          startTime: s.startTime,
          duration: s.duration,
          sourceFunctionName: s.sourceFunctionName,
        })),
      })
    }
  }).observe({ type: 'long-animation-frame', buffered: true })

  // Mode witness. On the patched build a router navigation keeps its
  // transition lane, so React's <ViewTransition> fires; on the control it
  // cannot. Counting real calls proves each block ran the build it claims to.
  window.__vt = 0
  const original = document.startViewTransition?.bind(document)
  if (original) {
    document.startViewTransition = (...args) => {
      window.__vt++
      return original(...args)
    }
  }
}

const percentile = (sorted, p) => {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[i]
}

const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.length
    ? sorted.reduce((a, b) => a + b, 0) / sorted.length
    : null
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    mean,
  }
}

/** Interaction latency per INP's definition: max duration per interactionId. */
const interactionLatencies = (events) => {
  const byId = new Map()
  for (const e of events) {
    byId.set(
      e.interactionId,
      Math.max(byId.get(e.interactionId) ?? 0, e.duration),
    )
  }
  return [...byId.values()]
}

/**
 * The frame that carries the click. Its duration is the main-thread work the
 * user waits through before anything can be painted.
 */
const clickFrame = (loafs) =>
  loafs.find((l) => l.firstUIEventTimestamp > 0) ?? null

async function runBlock(browser, label, base, rows) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  await context.addInitScript(observers)
  const page = await context.newPage()

  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })

  const listUrl = `${base}/?rows=${rows}`
  await page.goto(listUrl, { waitUntil: 'networkidle' })
  // Hydration must have finished, or the first clicks measure hydration.
  await page.waitForTimeout(1500)

  // Read the mode straight off the live router rather than trusting the port.
  const modeOn = await page.evaluate(
    () =>
      window.__TSR_ROUTER__?.options?.experimental_concurrentRenderFrames ??
      null,
  )
  const expected = label === 'patched'
  if (modeOn !== expected) {
    throw new Error(
      `${base} reports experimental_concurrentRenderFrames=${modeOn}, ` +
        `expected ${expected} for the "${label}" arm`,
    )
  }

  const samples = []
  for (let i = 0; i < WARMUP + CLICKS; i++) {
    const measured = i >= WARMUP
    await page.evaluate(() => {
      window.__perf.events.length = 0
      window.__perf.loafs.length = 0
      window.__vtBefore = window.__vt
    })

    const id = String((i % 4) + 2)
    await page.locator(`a.card[href^="/article/${id}"]`).click()
    await page.waitForURL(`**/article/${id}**`)
    await page.waitForTimeout(1200)

    if (measured) {
      samples.push(
        await page.evaluate(() => ({
          events: window.__perf.events,
          loafs: window.__perf.loafs,
          viewTransitions: window.__vt - window.__vtBefore,
        })),
      )
    }

    await page.goBack()
    await page.waitForURL((u) => new URL(u).pathname === '/')
    await page.waitForTimeout(900)
  }

  await context.close()
  return { label, base, rows, concurrentRenderFrames: modeOn, samples }
}

const browser = await chromium.launch({
  // The full Chromium build, not headless-shell: view transitions and paint
  // timing need a real compositor.
  channel: process.env.CHROME_CHANNEL ?? 'chromium',
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-experimental-web-platform-features'],
})

const blocks = []
for (const rows of ROWS) {
  for (let b = 0; b < BLOCKS; b++) {
    const order =
      b % 2 === 0
        ? [
            ['control', CONTROL],
            ['patched', PATCHED],
          ]
        : [
            ['patched', PATCHED],
            ['control', CONTROL],
          ]
    for (const [label, base] of order) {
      process.stderr.write(`rows=${rows} block ${b + 1}/${BLOCKS} ${label}\n`)
      blocks.push(await runBlock(browser, label, base, rows))
    }
  }
}
await browser.close()

const sweep = ROWS.map((rows) => {
  const arms = {}
  for (const label of ['control', 'patched']) {
    const samples = blocks
      .filter((b) => b.label === label && b.rows === rows)
      .flatMap((b) => b.samples)
    const latencies = samples.flatMap((s) => interactionLatencies(s.events))
    const clickFrames = samples
      .map((s) => clickFrame(s.loafs))
      .filter(Boolean)

    arms[label] = {
      navigations: samples.length,
      navigationsWithReportableInteraction: samples.filter(
        (s) => interactionLatencies(s.events).length > 0,
      ).length,
      viewTransitionsFired: samples.reduce((t, s) => t + s.viewTransitions, 0),
      interactionLatencyMs: summarise(latencies),
      clickFrameDurationMs: summarise(clickFrames.map((f) => f.duration)),
      clickFrameBlockingMs: summarise(clickFrames.map((f) => f.blockingDuration)),
      longAnimationFramesPerNavigation: summarise(
        samples.map((s) => s.loafs.length),
      ),
    }
  }
  return { rows, arms }
})

writeFileSync(
  OUT,
  JSON.stringify(
    {
      meta: {
        recordedAt: new Date().toISOString(),
        cpuThrottleRate: CPU,
        rowsSweep: ROWS,
        blocksPerPoint: BLOCKS,
        clicksPerBlock: CLICKS,
        warmupPerBlock: WARMUP,
        eventTimingFloorMs: EVENT_TIMING_FLOOR_MS,
        control: CONTROL,
        patched: PATCHED,
      },
      sweep,
      raw: blocks,
    },
    null,
    2,
  ),
)

const n = (v, w) => (v === null ? '—' : v.toFixed(0)).padStart(w)

console.log(`\nCPU throttle ${CPU}x · ${BLOCKS} blocks × ${CLICKS} clicks/point`)
console.log(
  '\n rows  arm       navs  vtFire   p50    p75    p95    max   clickFrame  blocking',
)
for (const point of sweep) {
  for (const label of ['control', 'patched']) {
    const a = point.arms[label]
    console.log(
      `${String(point.rows).padStart(5)}  ${label.padEnd(8)}` +
        `${String(a.navigations).padStart(5)}` +
        `${String(a.viewTransitionsFired).padStart(8)}` +
        `${n(a.interactionLatencyMs.p50, 6)}` +
        `${n(a.interactionLatencyMs.p75, 7)}` +
        `${n(a.interactionLatencyMs.p95, 7)}` +
        `${n(a.interactionLatencyMs.max, 7)}` +
        `${n(a.clickFrameDurationMs.p50, 13)}` +
        `${n(a.clickFrameBlockingMs.p50, 10)}`,
    )
  }
}
console.log(`\nwrote ${OUT}`)
