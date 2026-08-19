// ESLint flat config for the LyX Preview VS Code extension (lq/vsd_preview).
// Correctness-focused: typescript-eslint recommended (type-checked) plus the
// promise rules that catch silent async failures, and no-unsanitized for the
// webview HTML boundary (we will inject lq-rendered HTML into a webview).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noUnsanitized from "eslint-plugin-no-unsanitized";

export default tseslint.config(
  {
    ignores: ["out/", "dist/", "node_modules/", "eslint.config.mjs", "src/**/*.test.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "no-unsanitized": noUnsanitized },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
);
