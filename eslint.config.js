// Minimal lint: ESLint + typescript-eslint recommended (no type-aware rules, no style rules).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "contracts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // test/crossapp: plain Node scripts that also run code in the browser pages (manual, not in CI).
    files: ["test/crossapp/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        ["process", "console", "URL", "fetch", "setTimeout", "setInterval", "clearInterval", "window", "document", "navigator", "sessionStorage", "localStorage"].map((name) => [name, "readonly"]),
      ),
    },
  },
  {
    rules: {
      // `_`-prefixed names mark intentionally unused parameters/bindings.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
