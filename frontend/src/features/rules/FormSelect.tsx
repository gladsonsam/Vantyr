import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Full-width labelled select used by the rule editors. */
export function FormSelect({ value, options, onChange, placeholder, ariaLabel }: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(next: string | null) => { if (next !== null) onChange(next); }}>
      <SelectTrigger aria-label={ariaLabel} className="h-9 w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
