// Vite's `?raw` import suffix, which yields a module's source as a string.
// The project doesn't pull in `vite/client` types (that would drag the whole
// ambient browser/env surface in for one suffix), so declare just this form.
//
// Deliberately preferred over shimming `node:fs`: an ambient declaration is
// visible to the entire program, and declaring `node:fs` would let any
// component import it and still typecheck — silently removing the guarantee
// that the app never touches Node. `?raw` is a real Vite feature that app
// code may legitimately use, so declaring it opens no such hole.

declare module "*?raw" {
  const source: string;
  export default source;
}
