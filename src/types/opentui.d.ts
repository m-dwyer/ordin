/**
 * `@opentui/solid/preload` is a side-effect-only entry that installs
 * Bun's `.tsx` → Solid transform plugin. Its package.json `exports`
 * map points TS at the real `.ts` source, which transitively imports
 * `@babel/core` without its `@types/babel__core` companion. Declaring
 * the transitive module as `any` lets typecheck pass without dragging
 * babel types into our devDeps.
 */
declare module "@babel/core";
