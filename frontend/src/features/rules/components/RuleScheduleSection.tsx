import type { ReactNode } from "react";
import { Field, FieldLabel } from "@vantyr/ui/components/field";

/** Shared schedule layout; each rule form owns its typed fields and validation. */
export function RuleScheduleSection({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  return <Field>
    <FieldLabel>Schedule (optional)</FieldLabel>
    <div className="flex flex-col gap-3">{toggle}{children}</div>
  </Field>;
}
