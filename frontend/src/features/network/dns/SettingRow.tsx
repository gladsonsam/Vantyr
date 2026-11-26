import type { ReactNode } from "react";
import { SettingsRow } from "@/features/settings/components/SettingsLayout";

/** A label (with optional explanation on demand) on the left and its control on the right. */
export function SettingRow({
  label,
  help,
  description,
  children,
}: {
  label: string;
  help?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsRow label={label} help={help} description={description} controlClassName="md:justify-end">
      {children}
    </SettingsRow>
  );
}
