import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
  },
  define: {
    "import.meta.env.VITE_PLANKTON_API_KEY": JSON.stringify(""),
  },
});
