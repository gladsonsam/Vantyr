import { useId, type ReactNode } from "react";
import {
  Controller,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

export interface FormFieldRenderProps<T extends FieldValues, N extends FieldPath<T>> {
  field: ControllerRenderProps<T, N>;
  fieldState: ControllerFieldState;
  /** DOM id shared with the label's `htmlFor`. */
  id: string;
}

export interface FormFieldProps<T extends FieldValues, N extends FieldPath<T>> {
  control: Control<T>;
  name: N;
  label?: ReactNode;
  description?: ReactNode;
  /** DOM id for the control; generated when omitted. */
  id?: string;
  className?: string;
  children: (props: FormFieldRenderProps<T, N>) => ReactNode;
}

/**
 * Binds one react-hook-form field to the shadcn `Field` layout: label, the control you render,
 * description, then the field's validation message. Put `aria-invalid={fieldState.invalid}` on the
 * control to get the destructive ring.
 */
export function FormField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, className, children,
}: FormFieldProps<T, N>) {
  const generatedId = useId();
  const fieldId = id ?? `${generatedId}-${name}`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field className={className} data-invalid={fieldState.invalid || undefined}>
          {label ? <FieldLabel htmlFor={fieldId}>{label}</FieldLabel> : null}
          {children({ field, fieldState, id: fieldId })}
          {description ? <FieldDescription>{description}</FieldDescription> : null}
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}
