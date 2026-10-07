import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
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
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    // shadcn/ui generates these files and they co-export variants/hooks
    // (buttonVariants, useSidebar, …) alongside components; keep them as generated.
    // ErrorBoundary is a class component, which Fast Refresh can't preserve anyway.
    files: ["src/components/ui/**/*.tsx", "src/components/common/ErrorBoundary.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
