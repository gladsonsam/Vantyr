import { baseConfig } from "@vantyr/eslint-config";

// The agent UI is small and new enough to run react-hooks' full (React Compiler) rule set.
export default baseConfig({ reactCompilerRules: true });
