import { useEffect, type ComponentProps, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, AlertDescription } from "@vantyr/ui/components/alert";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import type { enrollCodeSchema, TwoFactorCodeValues } from "./twoFactorSchemas";

/**
 * One authenticator-code box with its submit button; the button stays disabled until the code is
 * acceptable. A refusal from the server (`error`) shows right under the box and puts the cursor
 * back in it with the code selected, so a wrong code is one retype away.
 */
export function TwoFactorCodeForm({ schema, id, label, hint, submitLabel, submitVariant, busy, error, codeKind = "digits", onSubmit, extraAction }: {
  schema: typeof enrollCodeSchema;
  id: string;
  label: string;
  /** Instruction that stays visible under the box (not behind a help icon). */
  hint?: string;
  submitLabel: string;
  submitVariant?: ComponentProps<typeof Button>["variant"];
  busy: boolean;
  error?: string | null;
  /** `text` lets a recovery code (letters and dashes) be typed on a phone keyboard. */
  codeKind?: "digits" | "text";
  onSubmit: (values: TwoFactorCodeValues) => void;
  extraAction?: ReactNode;
}) {
  const form = useForm<TwoFactorCodeValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { code: "" },
  });
  const { setFocus } = form;
  useEffect(() => {
    // Wait out `busy`: a disabled box can't take focus.
    if (error && !busy) setFocus("code", { shouldSelect: true });
  }, [error, busy, setFocus]);

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <form onSubmit={form.handleSubmit((values) => onSubmit(values))} noValidate aria-busy={busy} className="contents">
      <InputField
        control={form.control}
        name="code"
        id={id}
        label={label}
        placeholder={codeKind === "digits" ? "123456" : undefined}
        disabled={busy}
        autoComplete="one-time-code"
        inputMode={codeKind === "digits" ? "numeric" : "text"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
        className="h-9 pointer-coarse:h-10"
        hideError
      />
      {hint ? (
        <p id={hintId} className="-mt-2 text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" id={errorId}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={submitVariant} className="pointer-coarse:h-10" disabled={busy || !form.formState.isValid}>
          {busy && <Spinner />} {submitLabel}
        </Button>
        {extraAction}
      </div>
    </form>
  );
}
