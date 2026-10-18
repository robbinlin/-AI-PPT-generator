import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `@lvs/shared` re-exports its hashing helpers, which import `node:crypto`. The browser
// never calls them, so the import is pointed at a stub that throws if it ever is.
const nodeCryptoShim = fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^node:crypto$/, replacement: nodeCryptoShim }],
  },
  server: { port: 5173 },
});
