import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import type { enrollCodeSchema, TwoFactorCodeValues } from "./twoFactorSchemas";

/** One authenticator-code box with its submit button; the button stays disabled until the code is acceptable. */
export function TwoFactorCodeForm({ schema, id, label, hint, submitLabel, busy, onSubmit, extraAction }: {
  schema: typeof enrollCodeSchema;
  id: string;
  label: string;
  hint?: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: TwoFactorCodeValues) => void;
  extraAction?: ReactNode;
}) {
  const form = useForm<TwoFactorCodeValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { code: "" },
  });

  return (
    <form onSubmit={form.handleSubmit((values) => onSubmit(values))} noValidate className="contents">
      <InputField
        control={form.control}
        name="code"
        id={id}
        label={label}
        placeholder="123456"
        disabled={busy}
        autoComplete="one-time-code"
        inputMode="numeric"
        className="h-9"
        description={hint}
        hideError
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !form.formState.isValid}>
          {busy && <Spinner />} {submitLabel}
        </Button>
        {extraAction}
      </div>
    </form>
  );
}
