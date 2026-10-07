import { baseConfig } from "@vantyr/eslint-config";

export default [
  ...baseConfig(),
  {
    // ErrorBoundary is a class component, which Fast Refresh can't preserve anyway.
    files: ["src/components/common/ErrorBoundary.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
];
