import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RecallSettings } from "../../lib/types";

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

function clamp(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.max(lo, Math.min(hi, v));
}

interface RecallSettingsFieldsProps {
  value: RecallSettings;
  onChange: (patch: Partial<RecallSettings>) => void;
  disabled?: boolean;
}

/**
 * The Recall capture tunables, as a form.
 *
 * Shared by the fleet-default panel and the per-agent override so the two can't
 * drift in labelling, bounds or units. Every bound here matches the column's CHECK
 * constraint, so an out-of-range value is impossible to submit rather than being
 * rejected with a 400 after the fact.
 */
export function RecallSettingsFields({ value, onChange, disabled }: RecallSettingsFieldsProps) {
  const num = (raw: string) => Number(raw) || 0;

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <Checkbox
          checked={value.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked === true })}
          disabled={disabled}
          aria-label="Record screen history"
        />
        <FieldContent>
          <FieldTitle>Record screen history</FieldTitle>
          <FieldDescription>
            Off stops Recall recording; existing history is kept. Recording also requires the device’s locally enabled Recall module.
          </FieldDescription>
        </FieldContent>
      </Field>

      <Field>
        <Label htmlFor="recall-interval">Capture interval (seconds)</Label>
        <Input
          id="recall-interval"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.interval_ms / 1000))}
          onChange={(e) =>
            onChange({ interval_ms: clamp(num(e.target.value) * 1000, LIMITS.interval_ms) })
          }
          className="h-9"
        />
        <FieldDescription>
          Cadence while the machine is in use but not actively being interacted with.
        </FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="recall-hot-interval">Active interval (seconds)</Label>
        <Input
          id="recall-hot-interval"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.hot_interval_ms / 1000))}
          onChange={(e) =>
            onChange({ hot_interval_ms: clamp(num(e.target.value) * 1000, LIMITS.hot_interval_ms) })
          }
          className="h-9"
        />
        <FieldDescription>
          Faster cadence while typing or clicking, so busy stretches get denser coverage.
        </FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="recall-quality">JPEG quality (1–100)</Label>
        <Input
          id="recall-quality"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.jpeg_quality)}
          onChange={(e) =>
            onChange({ jpeg_quality: clamp(num(e.target.value), LIMITS.jpeg_quality) })
          }
          className="h-9"
        />
        <FieldDescription>
          These are review thumbnails, not archives. Higher quality multiplies disk use for every frame of every machine.
        </FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="recall-max-dim">Max dimension (px)</Label>
        <Input
          id="recall-max-dim"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.max_dim)}
          onChange={(e) => {
            const n = num(e.target.value);
            onChange({ max_dim: n === 0 ? 0 : clamp(n, MAX_DIM_RANGE) });
          }}
          className="h-9"
        />
        <FieldDescription>
          Longest edge after downscale. 0 stores frames at full resolution.
        </FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="recall-dedup">Duplicate threshold (0–64)</Label>
        <Input
          id="recall-dedup"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.dedup_hamming)}
          onChange={(e) =>
            onChange({ dedup_hamming: clamp(num(e.target.value), LIMITS.dedup_hamming) })
          }
          className="h-9"
        />
        <FieldDescription>
          Skip a frame whose perceptual hash is this close to the last stored one. 0 only skips identical screens; higher values store less but may miss small changes.
        </FieldDescription>
      </Field>

      <Field>
        <Label htmlFor="recall-keyframe-gap">Force a keyframe every (minutes)</Label>
        <Input
          id="recall-keyframe-gap"
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.keyframe_max_gap_ms / 60_000))}
          onChange={(e) =>
            onChange({
              keyframe_max_gap_ms: clamp(num(e.target.value) * 60_000, LIMITS.keyframe_max_gap_ms),
            })
          }
          className="h-9"
        />
        <FieldDescription>
          Requests a periodic frame even when the screen is unchanged. Offline devices, disabled modules, or capture failures can still leave gaps.
        </FieldDescription>
      </Field>

      <Field orientation="horizontal">
        <Checkbox
          checked={value.ocr}
          onCheckedChange={(checked) => onChange({ ocr: checked === true })}
          disabled={disabled || !value.enabled}
          aria-label="Recognize on-screen text (OCR)"
        />
        <FieldContent>
          <FieldTitle>Recognize on-screen text (OCR)</FieldTitle>
          <FieldDescription>
            Runs on-device text recognition on each stored frame. Without it, screens are still replayable but not searchable and text can&apos;t be selected off them.
          </FieldDescription>
        </FieldContent>
      </Field>

      {!value.enabled && (
        <p className="text-sm text-warning">
          Recall recording is off. These settings apply when recording and the device’s Recall module are both enabled.
        </p>
      )}
    </FieldGroup>
  );
}
