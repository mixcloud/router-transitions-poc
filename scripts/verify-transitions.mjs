/**
 * Objective version of the demo: counts calls to document.startViewTransition
 * for a React state update vs. a TanStack Router navigation.
 *
 *   pnpm dev
 *   pnpm exec playwright install chromium   # once
 *   pnpm verify
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
})
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })

await page.addInitScript(() => {
  window.__vt = 0
  const original = document.startViewTransition?.bind(document)
  if (!original) return
  document.startViewTransition = (...args) => {
    window.__vt++
    return original(...args)
  }
})

await page.goto(BASE, { waitUntil: 'networkidle' })

const count = () => page.evaluate(() => window.__vt)
const measure = async (label, action) => {
  const before = await count()
  await action()
  await page.waitForTimeout(1200)
  console.log(`${label.padEnd(42)} ${(await count()) - before} view transition(s)`)
}

await measure('A) React state + startTransition', () =>
  page.getByRole('button', { name: /React state/i }).click(),
)

await measure('B) Router navigate + startTransition', async () => {
  await page.getByRole('button', { name: /Router navigate/i }).click()
  await page.waitForURL('**/article/1')
})

await page.goBack()
await page.waitForTimeout(500)

await measure('C) <Link> navigation', async () => {
  await page.getByRole('link', { name: /router that forgot/i }).click()
  await page.waitForURL('**/article/2')
})

await browser.close()
