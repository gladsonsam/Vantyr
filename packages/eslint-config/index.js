import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

/**
 * Base flat config shared by every React workspace: ESLint + typescript-eslint recommended,
 * react-hooks, and the Fast Refresh rule.
 *
 * @param {object} [options]
 * @param {boolean} [options.reactCompilerRules] Use react-hooks' full `recommended` set, which in v7
 *   includes the React Compiler rules (set-state-in-effect, refs, ...). Off by default; both the
 *   dashboard and the agent UI opt in.
 */
export function baseConfig({ reactCompilerRules = false } = {}) {
  return tseslint.config(
    { ignores: ["dist", "node_modules", "eslint.config.js"] },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: globals.browser,
      },
      plugins: {
        "react-hooks": reactHooks,
        "react-refresh": reactRefresh,
      },
      rules: {
        ...(reactCompilerRules
          ? reactHooks.configs.flat.recommended.rules
          : {
              "react-hooks/rules-of-hooks": "error",
              "react-hooks/exhaustive-deps": "warn",
            }),
        "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      },
    },
  );
}

/**
 * Turn off Fast Refresh's export rule for generated shadcn/ui files: they co-export variants and
 * hooks (buttonVariants, useSidebar, ...) next to components, and are kept as generated.
 *
 * @param {string[]} files Glob patterns for the generated files, relative to the config.
 */
export function shadcnGenerated(files) {
  return { files, rules: { "react-refresh/only-export-components": "off" } };
}
