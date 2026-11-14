import { defineConfig } from 'vitest/config';

/*
 * Test configuration for the web workspace.
 *
 * Why this file exists: `tsconfig.json` sets `jsx: "preserve"`, because Next
 * owns the JSX transform in the app build. Vitest does not go through Next, so
 * without this it receives untransformed JSX and cannot parse any `.tsx` test.
 * Setting the transform here leaves the Next build untouched — the tsconfig is
 * shared with the app and is not the place to fix a test concern.
 *
 * `.mts` because Vite loads this natively as ESM; a `.ts` config is read as
 * CommonJS and warns.
 *
 * The environment stays `node`, which is what the pure-logic suites want.
 * Component tests opt into jsdom with a `// @vitest-environment jsdom`
 * docblock, so only those files pay for a DOM.
 */
export default defineConfig({
  // Vite 7 transforms with oxc; esbuild options are ignored.
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'react',
    },
  },
  test: {
    environment: 'node',
    restoreMocks: true,
    /*
     * The component suites import the signing stack, and the first test in a
     * file pays for transforming it. On a cold cache — which is every CI run —
     * that can exceed the 5 s default, and a suite that only passes warm is a
     * suite that fails in CI.
     */
    testTimeout: 20_000,
  },
});
