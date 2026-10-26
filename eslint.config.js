// Minimal lint: ESLint + typescript-eslint recommended (no type-aware rules, no style rules).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "contracts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed names mark intentionally unused parameters/bindings.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
