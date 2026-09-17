import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { buildStamp } from './scripts/build-id.mjs'

/**
 * Each build stamps its own source.
 *
 * The benchmark's premise is that both arms are builds of identical source,
 * and the stamp is how it checks that. Computing the stamp once in the shell
 * and passing it to both builds cannot check it: an edit between the two
 * builds, reverted before the run, leaves two different artifacts carrying
 * one stamp. Computing it here means each arm records the source it was
 * actually built from, so such a pair disagrees and the run refuses it.
 *
 * An explicit `VITE_BUILD_ID` still wins, for stamping a build deliberately.
 */
const BUILD_ID = buildStamp()

export default defineConfig({
  plugins: [tanstackStart(), viteReact()],
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
  },
})
