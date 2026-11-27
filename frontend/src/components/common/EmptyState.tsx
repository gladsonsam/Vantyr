import React from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vantyr/ui/components/empty";

interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  iconVariant?: "default" | "icon";
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  iconVariant = "default",
}: EmptyStateProps) {
  return (
    <Empty className="rounded-xl border border-dashed border-border/70 bg-card/10">
      <EmptyHeader>
        {icon ? <EmptyMedia variant={iconVariant}>{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
