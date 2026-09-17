#!/usr/bin/env node
/**
 * The identity of the source a build was made from.
 *
 * `HEAD` alone is not that identity: two arms built either side of an
 * uncommitted edit carry the same commit and therefore the same stamp, so the
 * benchmark's "both arms are builds of identical source" witness passes while
 * the arms differ. Anything uncommitted has to be part of the stamp.
 *
 * So the stamp is the commit, plus - when the tree is not clean - a short
 * hash of everything that makes it not clean: the diff against `HEAD`,
 * staged changes included, and the list of untracked files with their
 * contents. Any edit between two builds changes it, and the run then refuses
 * to compare them.
 *
 * Ignored files are usually build output, but not always: `src/routeTree.gen.ts`
 * is generated, ignored, and imported by `src/router.tsx`, so it is a build
 * input the stamp has to cover. Rather than guess, the roots that hold ignored
 * source are declared below, and everything git ignores inside them is hashed
 * alongside the untracked files. A generated input is present in every working
 * tree, including a freshly cloned one, so it earns its own suffix rather than
 * calling every build dirty: `-gen.` is a committed tree plus its generated
 * inputs, `-dirty.` is that plus uncommitted work.
 *
 * Printed by one script so the build commands and the benchmark's default
 * expectation cannot drift apart.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const git = (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/**
 * Directories whose ignored files are build inputs rather than build output.
 * `dist`, `.tanstack` and `node_modules` are outputs and dependencies and stay
 * out of the stamp; `src` holds the generated route tree, which the app
 * imports.
 */
const IGNORED_INPUT_ROOTS = ['src']

export function buildId() {
  let head
  try {
    head = git(['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    // No git, no answer, and no basis for a freshness claim.
    return undefined
  }
  const lines = (out) => out.split('\n').filter(Boolean)
  // Tracked changes, staged and unstaged alike.
  const diff = git(['diff', 'HEAD'])
  // Untracked files are source too - a new module the build imports.
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard']))
  // Ignored files under the roots that hold generated source are build inputs
  // rather than build output, so they belong in the identity as well.
  const generated = lines(
    git([
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...IGNORED_INPUT_ROOTS,
    ]),
  ).filter((path) => !untracked.includes(path))

  const dirt = createHash('sha256')
  dirt.update(diff)
  for (const path of [...untracked, ...generated].sort()) {
    dirt.update(`|${path}|`)
    try {
      dirt.update(readFileSync(path))
    } catch {
      // Vanished between listing and reading; the name still counts.
    }
  }
  const digest = dirt.digest('hex').slice(0, 8)

  // Nothing beyond the commit: the stamp is exactly "this commit, as
  // committed". Generated inputs alone are the ordinary case and say so;
  // uncommitted work is the one the benchmark warns about.
  if (!diff && !untracked.length && !generated.length) return head
  const uncommitted = Boolean(diff) || untracked.length > 0
  return `${head}-${uncommitted ? 'dirty' : 'gen'}.${digest}`
}

/**
 * What a build should stamp itself with: an explicit `VITE_BUILD_ID` when one
 * is set, otherwise the source identity above. Lives here rather than in
 * `vite.config.ts` so the config needs no Node globals of its own.
 */
export function buildStamp() {
  return process.env.VITE_BUILD_ID ?? buildId() ?? null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = buildId()
  if (!id) {
    console.error('build-id: not a git working tree')
    process.exit(1)
  }
  process.stdout.write(`${id}\n`)
}
