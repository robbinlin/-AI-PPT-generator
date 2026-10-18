import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts: tests need no React/Tailwind plugins (esbuild compiles
// TSX using tsconfig's `jsx: react-jsx`), and Node provides `node:crypto` natively.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
