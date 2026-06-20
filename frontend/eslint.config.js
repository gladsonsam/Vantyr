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
    files: [
      "src/components/ui/console.tsx",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-namespace": "off",
      "no-case-declarations": "off",
    },
  },
  {
    files: [
      "src/components/ui/ToastProvider.tsx",
      "src/lib/agentIcons.tsx",
      "src/lib/agentTabNav.tsx",
      "src/layouts/DashboardLayout.tsx",
      "src/components/common/ErrorBoundary.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
