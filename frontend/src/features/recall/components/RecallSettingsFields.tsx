import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup } from "@vantyr/ui/components/field";
import { Input } from "@vantyr/ui/components/input";
import { Label } from "@vantyr/ui/components/label";
import { cn } from "@/lib/utils";
import type { RecallSettings } from "@/api/types";

/** Bounds mirroring the CHECK constraints, so the form can't submit a 400. */
const LIMITS = {
  interval_ms: [1_000, 3_600_000],
  hot_interval_ms: [1_000, 3_600_000],
  jpeg_quality: [1, 100],
  dedup_hamming: [0, 64],
  keyframe_max_gap_ms: [10_000, 86_400_000],
} as const;

/** `max_dim` also allows 0, meaning "don't downscale". */
const MAX_DIM_RANGE = [320, 7680] as const;

type Range = readonly [number, number];

/** Seconds or minutes as typed, without float noise (1500 ms is "1.5", not "1.5000000001"). */
function units(raw: number, perUnit: number): string {
  return String(Number((raw / perUnit).toFixed(2)));
}

/**
 * Parses what was typed into the stored value, or `null` while it is not a usable value. Out-of-range
 * text is never clamped as it is typed (that turns "1" into 320 before "1920" can be typed); it is
 * reported, and the field returns to the last valid value when it loses focus.
 */
function parseTyped(
  text: string,
  perUnit: number,
  range: Range,
  extra: readonly number[],
): number | null {
  const trimmed = text.trim();
  if (!(perUnit === 1 ? /^\d+$/ : /^\d+(\.\d+)?$/).test(trimmed)) return null;
  const value = Math.round(Number(trimmed) * perUnit);
  if (extra.includes(value)) return value;
  return value >= range[0] && value <= range[1] ? value : null;
}

interface NumberFieldProps {
  id: string;
  label: string;
  /** Stored value, in the stored unit. */
  value: number;
  /** Stored units per displayed unit (1000 for seconds shown from milliseconds). */
  perUnit: number;
  range: Range;
  /** Extra allowed values outside the range (0 = no downscale). */
  extra?: readonly number[];
  rangeText: string;
  onCommit: (value: number) => void;
  disabled: boolean;
  description?: string;
  /** The inherited value when it differs from `value`, already formatted. */
  differsFrom?: string;
}

function NumberField({
  id,
  label,
  value,
  perUnit,
  range,
  extra = [],
  rangeText,
  onCommit,
  disabled,
  description,
  differsFrom,
}: NumberFieldProps) {
  const shown = units(value, perUnit);
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  // A value that changed from outside (load, reset, save) replaces whatever was typed.
  if (seen !== shown) {
    setSeen(shown);
    setText(shown);
  }
  const invalid = parseTyped(text, perUnit, range, extra) === null;
  const hintId = `${id}-hint`;
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode={perUnit === 1 ? "numeric" : "decimal"}
        step={perUnit === 1 ? 1 : "any"}
        disabled={disabled}
        value={text}
        aria-invalid={invalid}
        aria-describedby={hintId}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseTyped(event.target.value, perUnit, range, extra);
          if (next !== null) onCommit(next);
        }}
        onBlur={() => setText(shown)}
        className="h-9"
      />
      <FieldDescription id={hintId} className={cn(invalid && "text-destructive")}>
        {invalid ? `Enter ${rangeText}. Leaving the box restores ${shown}.` : description}
        {!invalid && differsFrom && <span className="block">Fleet default: {differsFrom}</span>}
      </FieldDescription>
    </Field>
  );
}

function CheckField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  differsFrom,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  differsFrom?: string;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        aria-label={label}
      />
      <FieldContent>
        {/* A real label, so the text is part of the tap target and not just the 16px box. */}
        <Label htmlFor={id} className="w-fit">
          {label}
        </Label>
        {description && <FieldDescription>{description}</FieldDescription>}
        {differsFrom && <FieldDescription>Fleet default: {differsFrom}</FieldDescription>}
      </FieldContent>
    </Field>
  );
}

function AdvancedOptions({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-foreground/[0.08]">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="recall-advanced"
          onClick={() => setOpen((was) => !was)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span>More options</span>
          <span className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted-foreground">
            {summary}
          </span>
        </button>
      </h4>
      {open && (
        <div
          id="recall-advanced"
          className="grid grid-cols-1 gap-4 border-t border-foreground/[0.06] p-3 sm:grid-cols-2"
        >
          {children}
        </div>
      )}
    </section>
  );
}

interface RecallSettingsFieldsProps {
  value: RecallSettings;
  onChange: (patch: Partial<RecallSettings>) => void;
  disabled?: boolean;
  /** Replaces the default note under "Record screen" (the per-device form says it in its status line instead). */
  recordNote?: ReactNode;
  /** The inherited values: a field that differs from them says what the default is. */
  defaults?: RecallSettings;
}

/**
 * The Recall capture tunables, as a form.
 *
 * Shared by the fleet-default panel and the per-agent override so the two can't
 * drift in labelling, bounds or units. Every bound here matches the column's CHECK
 * constraint, so an out-of-range value is impossible to submit rather than being
 * rejected with a 400 after the fact. What is needed day to day (on/off, timing,
 * quality, text search) is always visible; the tuning knobs sit under "More options".
 */
export function RecallSettingsFields({
  value,
  onChange,
  disabled,
  recordNote = "Also needs the device’s Recall module.",
  defaults,
}: RecallSettingsFieldsProps) {
  const locked = Boolean(disabled) || !value.enabled;
  const secondsDiffer = (key: "interval_ms" | "hot_interval_ms") =>
    defaults && defaults[key] !== value[key] ? `${units(defaults[key], 1000)} s` : undefined;
  const differs = <K extends keyof RecallSettings>(
    key: K,
    format: (v: RecallSettings[K]) => string,
  ) => (defaults && defaults[key] !== value[key] ? format(defaults[key]) : undefined);
  const onOff = (enabled: boolean) => (enabled ? "on" : "off");

  return (
    <FieldGroup>
      <CheckField
        id="recall-enabled"
        label="Record screen"
        description={recordNote}
        checked={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
        disabled={Boolean(disabled)}
        differsFrom={differs("enabled", onOff)}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          id="recall-interval"
          label="Interval (seconds)"
          value={value.interval_ms}
          perUnit={1000}
          range={LIMITS.interval_ms}
          rangeText="1 to 3600 seconds"
          onCommit={(interval_ms) => onChange({ interval_ms })}
          disabled={locked}
          differsFrom={secondsDiffer("interval_ms")}
        />
        <NumberField
          id="recall-hot-interval"
          label="Active interval (seconds)"
          value={value.hot_interval_ms}
          perUnit={1000}
          range={LIMITS.hot_interval_ms}
          rangeText="1 to 3600 seconds"
          onCommit={(hot_interval_ms) => onChange({ hot_interval_ms })}
          disabled={locked}
          description="While typing or clicking."
          differsFrom={secondsDiffer("hot_interval_ms")}
        />
        <NumberField
          id="recall-quality"
          label="JPEG quality (1–100)"
          value={value.jpeg_quality}
          perUnit={1}
          range={LIMITS.jpeg_quality}
          rangeText="a whole number from 1 to 100"
          onCommit={(jpeg_quality) => onChange({ jpeg_quality })}
          disabled={locked}
          differsFrom={differs("jpeg_quality", String)}
        />
        <NumberField
          id="recall-max-dim"
          label="Max dimension (px)"
          value={value.max_dim}
          perUnit={1}
          range={MAX_DIM_RANGE}
          extra={[0]}
          rangeText="0 for full resolution, or 320 to 7680"
          onCommit={(max_dim) => onChange({ max_dim })}
          disabled={locked}
          description="Longest edge. 0 = full resolution."
          differsFrom={differs("max_dim", String)}
        />
      </div>

      <CheckField
        id="recall-ocr"
        label="Text recognition (OCR)"
        description="Makes screens searchable."
        checked={value.ocr}
        onChange={(ocr) => onChange({ ocr })}
        disabled={locked}
        differsFrom={differs("ocr", onOff)}
      />

      <AdvancedOptions
        summary={`Duplicates ${value.dedup_hamming} · keyframe every ${units(value.keyframe_max_gap_ms, 60_000)} min`}
      >
        <NumberField
          id="recall-dedup"
          label="Duplicate threshold (0–64)"
          value={value.dedup_hamming}
          perUnit={1}
          range={LIMITS.dedup_hamming}
          rangeText="a whole number from 0 to 64"
          onCommit={(dedup_hamming) => onChange({ dedup_hamming })}
          disabled={locked}
          description="Higher skips more; 0 skips only identical."
          differsFrom={differs("dedup_hamming", String)}
        />
        <NumberField
          id="recall-keyframe-gap"
          label="Keyframe every (minutes)"
          value={value.keyframe_max_gap_ms}
          perUnit={60_000}
          range={LIMITS.keyframe_max_gap_ms}
          rangeText="0.17 to 1440 minutes"
          onCommit={(keyframe_max_gap_ms) => onChange({ keyframe_max_gap_ms })}
          disabled={locked}
          differsFrom={differs("keyframe_max_gap_ms", (ms) => `${units(ms, 60_000)} min`)}
        />
      </AdvancedOptions>
    </FieldGroup>
  );
}
