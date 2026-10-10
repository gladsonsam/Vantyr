import { baseConfig, shadcnGenerated } from "@vantyr/eslint-config";

export default [
  ...baseConfig(),
  // shadcn/ui generates these files; keep them as generated.
  shadcnGenerated(["src/components/**/*.tsx"]),
];
