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

export function buildId() {
  let head
  try {
    head = git(['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    // No git, no answer, and no basis for a freshness claim.
    return undefined
  }
  const dirt = createHash('sha256')
  // Tracked changes, staged and unstaged alike.
  dirt.update(git(['diff', 'HEAD']))
  // Untracked files are source too - a new module the build imports.
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .sort()
  for (const path of untracked) {
    dirt.update(`|${path}|`)
    try {
      dirt.update(readFileSync(path))
    } catch {
      // Vanished between listing and reading; the name still counts.
    }
  }
  const digest = dirt.digest('hex')
  // The digest of an empty stream is the clean tree, and a clean tree is just
  // its commit - so a stamp with no suffix means exactly "this commit, as
  // committed".
  const clean = createHash('sha256').update('').digest('hex')
  return digest === clean ? head : `${head}-dirty.${digest.slice(0, 8)}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = buildId()
  if (!id) {
    console.error('build-id: not a git working tree')
    process.exit(1)
  }
  process.stdout.write(`${id}\n`)
}
