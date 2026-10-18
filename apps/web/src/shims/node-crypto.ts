/** Browser stand-in for `node:crypto`; see vite.config.ts. Hashing happens server-side only. */
export function createHash(): never {
  throw new Error("node:crypto is not available in the browser");
}
