# Oxlint configuration

Both applications extend react-compiler.json; the shared UI package extends base.json.
Workspace configs keep browser globals, generated-file exclusions and Fast Refresh exceptions local.

The rules were converted with @oxlint/migrate 1.95.0 from the previous shared configuration.
Native React rules include Hooks and React Compiler checks. Strict mode covers duplicate arguments
and legacy octal syntax; Oxlint uses fixed valid Compiler options rather than separate config/gating rules.
Type checking remains in each workspace build/typecheck script.

Run npm run lint from the repository root, or npm run lint:fix for fixes across workspaces.
React Doctor remains a separate check and retains its own transitive ESLint plugin dependencies.
