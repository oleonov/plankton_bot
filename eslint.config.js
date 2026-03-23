import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tanstackQuery from "@tanstack/eslint-plugin-query";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "research/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "warn",
    },
  },
  // React hooks rules — scoped to web frontend
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  // TanStack Query rules — scoped to web frontend
  ...tanstackQuery.configs["flat/recommended"].map((cfg) => ({
    ...cfg,
    files: ["apps/web/**/*.{ts,tsx}"],
  })),
);
