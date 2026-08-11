import js from "@eslint/js";
import globals from "globals";
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
      // Fastify route handlers and hooks are async by convention even without await
      "@typescript-eslint/require-await": "off",
      // Polymarket SDK and external APIs lack proper types — any is unavoidable at boundaries
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      // Template literals with unknown types are common in logging
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      // Unused vars: allow underscore-prefixed (intentional ignores)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Plain-JS operator scripts belong to no tsconfig project, so the type-aware parser service
  // cannot load them — parse them untyped and give them Node's globals instead.
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: globals.node,
    },
  },
  // Test files — relax rules that are noisy in test contexts
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Test mocks use object literals with methods that trigger unbound-method
      "@typescript-eslint/unbound-method": "off",
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
