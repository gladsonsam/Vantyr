import { SpaceBetween, FormField, SelectProps, Select } from "../ui/console";
export type TimeRange = "24h" | "7d" | "30d" | "custom";

interface TimelineFiltersProps {
  selectedRange: TimeRange;
  onRangeChange: (range: TimeRange) => void;
}

const RANGE_OPTIONS: SelectProps.Option[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export function TimelineFilters({
  selectedRange,
  onRangeChange,
}: TimelineFiltersProps) {
  const selectedOption = RANGE_OPTIONS.find((opt) => opt.value === selectedRange) || RANGE_OPTIONS[0];

  return (
    <SpaceBetween size="l" direction="horizontal">
      <FormField label="Time range">
        <Select
          selectedOption={selectedOption}
          onChange={({ detail }) => onRangeChange(detail.selectedOption.value as TimeRange)}
          options={RANGE_OPTIONS}
        />
      </FormField>
    </SpaceBetween>
  );
}
