import { Box, FormField, Input, SpaceBetween, Toggle } from "../ui/console";
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
    <SpaceBetween size="s">
      <Toggle
        checked={value.enabled}
        onChange={({ detail }) => onChange({ enabled: detail.checked })}
        disabled={disabled}
        description="Off stops screen capture entirely. Agents apply this live and remember it across restarts; existing history is kept."
      >
        Record screen history
      </Toggle>

      <FormField
        label="Capture interval (seconds)"
        description="Cadence while the machine is in use but not actively being interacted with."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.interval_ms / 1000))}
          onChange={({ detail }) =>
            onChange({ interval_ms: clamp(num(detail.value) * 1000, LIMITS.interval_ms) })
          }
        />
      </FormField>

      <FormField
        label="Active interval (seconds)"
        description="Faster cadence while typing or clicking, so busy stretches get denser coverage."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.hot_interval_ms / 1000))}
          onChange={({ detail }) =>
            onChange({ hot_interval_ms: clamp(num(detail.value) * 1000, LIMITS.hot_interval_ms) })
          }
        />
      </FormField>

      <FormField
        label="JPEG quality (1–100)"
        description="These are review thumbnails, not archives. Higher quality multiplies disk use for every frame of every machine."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.jpeg_quality)}
          onChange={({ detail }) =>
            onChange({ jpeg_quality: clamp(num(detail.value), LIMITS.jpeg_quality) })
          }
        />
      </FormField>

      <FormField
        label="Max dimension (px)"
        description="Longest edge after downscale. 0 stores frames at full resolution."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.max_dim)}
          onChange={({ detail }) => {
            const n = num(detail.value);
            onChange({ max_dim: n === 0 ? 0 : clamp(n, MAX_DIM_RANGE) });
          }}
        />
      </FormField>

      <FormField
        label="Duplicate threshold (0–64)"
        description="Skip a frame whose perceptual hash is this close to the last stored one. 0 only skips identical screens; higher values store less but may miss small changes."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(value.dedup_hamming)}
          onChange={({ detail }) =>
            onChange({ dedup_hamming: clamp(num(detail.value), LIMITS.dedup_hamming) })
          }
        />
      </FormField>

      <FormField
        label="Force a keyframe every (minutes)"
        description="Guarantees coverage even on an unchanged screen, so a quiet stretch is provably 'the machine was on' rather than a hole."
      >
        <Input
          type="number"
          inputMode="numeric"
          disabled={disabled || !value.enabled}
          value={String(Math.round(value.keyframe_max_gap_ms / 60_000))}
          onChange={({ detail }) =>
            onChange({
              keyframe_max_gap_ms: clamp(num(detail.value) * 60_000, LIMITS.keyframe_max_gap_ms),
            })
          }
        />
      </FormField>

      <Toggle
        checked={value.ocr}
        onChange={({ detail }) => onChange({ ocr: detail.checked })}
        disabled={disabled || !value.enabled}
        description="Runs on-device text recognition on each stored frame. Without it, screens are still replayable but not searchable and text can't be selected off them."
      >
        Recognize on-screen text (OCR)
      </Toggle>

      {!value.enabled && (
        <Box fontSize="body-s" color="text-status-warning">
          Capture is off — the other settings take effect when it's turned back on.
        </Box>
      )}
    </SpaceBetween>
  );
}
