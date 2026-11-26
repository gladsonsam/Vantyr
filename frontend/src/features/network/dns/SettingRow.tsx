import type { ReactNode } from "react";
import { HelpTip } from "@/components/common/HelpTip";

/** A label (with optional explanation on demand) on the left and its control on the right. */
export function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-3.5">
      <div className="flex items-center gap-1.5 text-sm">
        {label}
        {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}
