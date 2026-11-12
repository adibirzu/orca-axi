import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    coverage: {
      include: ["src/paperclip/**/*.ts"],
      exclude: ["src/paperclip/__tests__/**"],
    },
  },
});
