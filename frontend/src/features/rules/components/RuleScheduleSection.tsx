import type { ReactNode } from "react";
import { Field, FieldLabel } from "@vantyr/ui/components/field";

/** Said wherever hours are chosen: the clock the times follow, and that overnight windows work. */
export const SCHEDULE_TIME_NOTE = "Times follow each device’s own clock. A window can run overnight, such as 22:00 to 06:00.";

/** Shared schedule layout; each rule form owns its typed fields and validation. */
export function RuleScheduleSection({ toggle, children }: { toggle: ReactNode; children: ReactNode }) {
  return (
    <Field>
      <FieldLabel>Schedule</FieldLabel>
      <div className="flex flex-col gap-3">
        {toggle}
        {children}
      </div>
    </Field>
  );
}
