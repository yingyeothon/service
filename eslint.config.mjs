import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/dist/**",
    "**/coverage/**",
    "**/node_modules/**",
    "**/.serverless/**",
    "**/.esbuild/**",
    // Prisma-generated client (checked ignored, not committed style).
    "**/src/generated/**",
    // Plain CommonJS tool config (no TS project).
    "**/postcss.config.cjs",
    "cli/**",
    "layers/**",
    // Standalone pnpm root with its own eslint config (examples/sample-dungeon).
    "examples/**",
    "local/**",
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.mjs",
            "*.ts",
            "packages/*/prisma.config.ts",
            "scripts/*.mjs",
            "scripts/smoke/*.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/test/**"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
