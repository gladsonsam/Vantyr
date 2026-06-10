import { Box, Button, SpaceBetween } from "../ui/console";

interface TableEmptyStateProps {
  title: string;
  subtitle: string;
  actionText?: string;
  onActionClick?: () => void;
}

export function TableEmptyState({
  title,
  subtitle,
  actionText,
  onActionClick,
}: TableEmptyStateProps) {
  return (
    <Box textAlign="center" color="inherit" padding="xxl">
      <SpaceBetween size="m">
        <Box variant="h3" color="inherit">
          {title}
        </Box>
        <Box variant="p" color="inherit">
          {subtitle}
        </Box>
        {actionText && onActionClick && (
          <Button onClick={onActionClick}>{actionText}</Button>
        )}
      </SpaceBetween>
    </Box>
  );
}

interface TableNoMatchStateProps {
  onClearFilter: () => void;
}

export function TableNoMatchState({ onClearFilter }: TableNoMatchStateProps) {
  return (
    <Box textAlign="center" color="inherit" padding="xxl">
      <SpaceBetween size="m">
        <Box variant="h3" color="inherit">
          No matches
        </Box>
        <Box variant="p" color="inherit">
          We can’t find a match for your search.
        </Box>
        <Button onClick={onClearFilter}>Clear filter</Button>
      </SpaceBetween>
    </Box>
  );
}
