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
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CONTROL = process.env.CONTROL ?? 'http://localhost:4173'
const PATCHED = process.env.PATCHED ?? 'http://localhost:4174'
const ROWS = (process.env.ROWS ?? '0,500,2000,6000').split(',').map(Number)
const BLOCKS = Number(process.env.BLOCKS ?? 8)
const CLICKS = Number(process.env.CLICKS ?? 6)
const WARMUP = Number(process.env.WARMUP ?? 2)
const CPU = Number(process.env.CPU ?? 6)
const OUT = process.env.OUT ?? 'benchmark-results.json'

/**
 * The build both arms are required to be.
 *
 * Cross-arm agreement is not freshness. `--strictPort` makes `vite preview`
 * refuse an occupied port, so a server left running from an earlier build
 * keeps serving that build — and if *both* ports are held that way, the two
 * arms agree with each other while the run measures code that no longer
 * exists. Learning the reference value from the first server cannot catch
 * that, because the first server is the stale one.
 *
 * So the expected stamp comes from outside the run. `EXPECT_BUILD_ID` names
 * it explicitly; otherwise it defaults to the working tree's `HEAD`, which is
 * what the README's build commands stamp the arms with. `EXPECT_BUILD_ID=any`
 * opts out, for measuring a build that deliberately is not `HEAD` — the run
 * then falls back to cross-arm agreement alone and says so in its output.
 */
const EXPECT_BUILD_ID = (() => {
  const configured = process.env.EXPECT_BUILD_ID
  if (configured) {
    return configured === 'any' ? undefined : configured
  }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // No git, no answer, and no basis for a freshness claim.
    return undefined
  }
})()

/**
 * Event Timing refuses to report an interaction shorter than 16ms, so an
 * absent entry is itself a measurement — faster than the API can see — rather
 * than a failed one.
 */
const EVENT_TIMING_FLOOR_MS = 16

const observers = (FLOOR) => {
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
  }).observe({
    type: 'event',
    durationThreshold: FLOOR,
    buffered: true,
  })

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

/**
 * Interaction latency per INP's definition: max duration per interactionId.
 *
 * May be empty: Event Timing refuses to report an interaction shorter than
 * `EVENT_TIMING_FLOOR_MS`, so a navigation faster than the API can see
 * produces no entry at all. That absence is a measurement, not a miss — see
 * `armLatencies`, which is where it has to be handled, because dropping those
 * navigations here would make every percentile conditional on the arm being
 * slow enough to observe.
 */
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
 * Every measured navigation's latency, with the unobservable ones kept.
 *
 * A navigation with no Event Timing entry is *left-censored*: its true
 * latency is somewhere below the floor, and the floor is therefore an upper
 * bound for it. Substituting the floor keeps the navigation in the
 * distribution and makes every percentile an upper bound on the real one —
 * which is the conservative direction for the fast arm, and the only way the
 * two arms describe the same set of navigations. `censored` reports how many
 * samples that was, so a reader can see how much of an arm is bounded rather
 * than observed.
 */
const armLatencies = (samples) => {
  const values = []
  let censored = 0
  for (const sample of samples) {
    const observed = interactionLatencies(sample.events)
    if (observed.length) {
      values.push(...observed)
    } else {
      censored++
      values.push(EVENT_TIMING_FLOOR_MS)
    }
  }
  return { values, censored }
}

/**
 * The frame that carries the click. Its duration is the main-thread work the
 * user waits through before anything can be painted.
 */
const clickFrame = (loafs) =>
  loafs.find((l) => l.firstUIEventTimestamp > 0) ?? null

/**
 * Wait for a preview server to answer, so a benchmark started alongside
 * `vite preview` fails on a server that never comes up rather than on the
 * first `page.goto`.
 */
async function waitForServer(base) {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(base, { method: 'GET' })
      if (response.ok) {
        return
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`${base} did not answer within 30s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * The build every block has reported so far.
 *
 * Seeded from `EXPECT_BUILD_ID` when there is one, so the first server is
 * checked rather than believed; otherwise from the first block, which still
 * catches two arms disagreeing with each other. Either way the mode check
 * alone would accept a stale server, because the mode is right — comparing
 * the stamp is what makes "builds of identical source" a checked claim
 * instead of a trusted one.
 */
let requiredBuildId = EXPECT_BUILD_ID

async function runBlock(browser, label, base, rows) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  // The arm check below throws on a mismatch, which is the point — but it must
  // not strand the context and its CDP session, or `browser.close()` never
  // runs and the process hangs after reporting the real problem.
  try {
    return await measureBlock(context, label, base, rows)
  } finally {
    await context.close()
  }
}

async function measureBlock(context, label, base, rows) {
  await context.addInitScript(observers, EVENT_TIMING_FLOOR_MS)
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
  const buildId = await page.evaluate(() => window.__BUILD_ID__ ?? null)
  if (!buildId) {
    throw new Error(
      `${base} reports no build stamp. Build both arms with ` +
        'VITE_BUILD_ID set (see README "Benchmarking") so the two arms can ' +
        'be checked against each other.',
    )
  }
  requiredBuildId ??= buildId
  if (buildId !== requiredBuildId) {
    throw new Error(
      EXPECT_BUILD_ID
        ? `${base} serves build ${buildId}, but this run expects ` +
          `${EXPECT_BUILD_ID}. Rebuild both arms from it and restart both ` +
          'preview servers — or set EXPECT_BUILD_ID to the build you mean ' +
          "to measure, or 'any' to check the arms against each other only."
        : `${base} serves build ${buildId}, but this run started against ` +
          `${requiredBuildId}. Both arms must be builds of the same source — ` +
          'rebuild and restart both preview servers.',
    )
  }

  const expected = label === 'patched'
  if (modeOn !== expected) {
    throw new Error(
      `${base} reports experimental_concurrentRenderFrames=${modeOn}, ` +
        `expected ${expected} for the "${label}" arm`,
    )
  }

  // Mode witness. On the patched build a router navigation keeps its
  // transition lane, so React's <ViewTransition> fires; on the control it
  // cannot, so counting real calls proves each block ran the build it claims.
  // The count is the application's own tally (`TransitionCounter` wraps
  // `document.startViewTransition` and increments `window.__vt`) — wrapping it
  // again from here would count every transition twice. Assert the tally
  // exists rather than reading `undefined` and silently reporting zero.
  const tally = await page.evaluate(() => typeof window.__vt)
  if (tally !== 'number') {
    throw new Error(
      `${base} exposes no window.__vt tally (typeof ${tally}); the ` +
        'transition witness would be dead. Is TransitionCounter mounted?',
    )
  }
  // The tally existing only proves the counter mounted; it is seeded even
  // where the platform has no View Transition API. Each measured navigation
  // is checked against what its arm must produce, below.
  const expectedTransitions = expected ? 1 : 0

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
      const sample = await page.evaluate(() => ({
        events: window.__perf.events,
        loafs: window.__perf.loafs,
        viewTransitions: window.__vt - window.__vtBefore,
      }))
      // The latency claim rests on a transition providing the next paint, so a
      // navigation that did not produce exactly the transitions its arm
      // requires is not a slower sample — it is a different experiment, and
      // averaging it in would hide whatever went wrong.
      if (sample.viewTransitions !== expectedTransitions) {
        throw new Error(
          `${base} rows=${rows}: navigation ${i - WARMUP + 1} ran ` +
            `${sample.viewTransitions} view transition(s), expected ` +
            `${expectedTransitions} for the "${label}" arm`,
        )
      }
      samples.push(sample)
    }

    await page.goBack()
    await page.waitForURL((u) => new URL(u).pathname === '/')
    await page.waitForTimeout(900)
  }

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
// Every validation in `runBlock` throws on purpose — a stale build stamp, the
// wrong mode, a navigation with no transition — and a throw here is the run
// reporting a problem rather than publishing a number it cannot stand behind.
// Without the `finally`, that throw skipped `browser.close()`: the diagnostic
// never reached the terminal because the process stayed alive holding an open
// Chromium.
try {
  await Promise.all([waitForServer(CONTROL), waitForServer(PATCHED)])

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
} finally {
  await browser.close()
}

const sweep = ROWS.map((rows) => {
  const arms = {}
  for (const label of ['control', 'patched']) {
    const samples = blocks
      .filter((b) => b.label === label && b.rows === rows)
      .flatMap((b) => b.samples)
    const { values: latencies, censored } = armLatencies(samples)
    const clickFrames = samples
      .map((s) => clickFrame(s.loafs))
      .filter(Boolean)

    arms[label] = {
      navigations: samples.length,
      navigationsWithReportableInteraction: samples.length - censored,
      // Navigations too fast for Event Timing, counted at the floor above.
      navigationsCensoredAtFloor: censored,
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
        buildId: requiredBuildId,
        // Whether that stamp was required from outside the run or merely
        // agreed on by the two arms. Only the first is a freshness claim.
        buildIdRequired: EXPECT_BUILD_ID !== undefined,
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
  `\nbuild ${requiredBuildId} ${
    EXPECT_BUILD_ID ? '(required)' : '(agreed by both arms, not required)'
  } · latency percentiles are upper bounds where a ` +
    `navigation was faster than Event Timing's ${EVENT_TIMING_FLOOR_MS}ms ` +
    'floor (the "<16" column counts those)',
)
console.log(
  '\n rows  arm       navs  vtFire   <16   p50    p75    p95    max   clickFrame  blocking',
)
for (const point of sweep) {
  for (const label of ['control', 'patched']) {
    const a = point.arms[label]
    console.log(
      `${String(point.rows).padStart(5)}  ${label.padEnd(8)}` +
        `${String(a.navigations).padStart(5)}` +
        `${String(a.viewTransitionsFired).padStart(8)}` +
        `${String(a.navigationsCensoredAtFloor).padStart(6)}` +
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
