import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { InputField, NumberField } from "@/components/common/form/fields";
import {
  DEFAULT_TOKEN_VALUES,
  enrollmentTokenSchema,
  parseTokenUses,
  tokenValuesToBody,
  type EnrollmentTokenBody,
  type EnrollmentTokenValues,
} from "./lib/enrollmentTokenForm";

const LAYOUTS = {
  card: {
    grid: "grid grid-cols-1 gap-5 md:grid-cols-3",
    buttons: "flex flex-wrap items-center gap-2",
    input: "h-9",
    uses: "How many claims can use this code.",
    expire: "Leave empty for 10 minutes.",
    note: "Shown only in the API response.",
  },
  dialog: {
    grid: "grid gap-4 sm:grid-cols-3",
    buttons: "flex gap-2",
    input: undefined,
    uses: "Pending claims per code.",
    expire: "Leave empty for no expiry.",
    note: "Stored with the token record.",
  },
} as const;

/**
 * Options for a new pairing code plus the "Generate code" button. Renders as the fields and the
 * button row directly in its parent. `onGenerate` reports its own failures; the button spins until
 * it settles. `extra` sits next to the button (e.g. "Copy code").
 */
export function EnrollmentTokenForm({ layout, onGenerate, extra }: {
  layout: keyof typeof LAYOUTS;
  onGenerate: (body: EnrollmentTokenBody) => Promise<void>;
  extra?: ReactNode;
}) {
  const l = LAYOUTS[layout];
  const form = useForm<EnrollmentTokenValues>({
    resolver: zodResolver(enrollmentTokenSchema),
    defaultValues: DEFAULT_TOKEN_VALUES,
  });
  const { control } = form;
  const { isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    await onGenerate(tokenValuesToBody(values));
  });

  return (
    <form onSubmit={submit} noValidate className="contents">
      <div className={l.grid}>
        <NumberField
          control={control}
          name="uses"
          id="enroll-uses"
          label="Uses"
          inputMode="numeric"
          parse={parseTokenUses}
          className={l.input}
          description={l.uses}
        />
        <InputField control={control} name="expire_hours" id="enroll-expire" label="Expires in (hours)" placeholder="e.g. 72" className={l.input} description={l.expire} />
        <InputField control={control} name="note" id="enroll-note" label="Note (optional)" className={l.input} description={l.note} />
      </div>
      <div className={l.buttons}>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Spinner />} Generate code
        </Button>
        {extra}
      </div>
    </form>
  );
}
