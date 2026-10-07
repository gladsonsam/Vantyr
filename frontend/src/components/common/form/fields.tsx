import type { ComponentProps, ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FormField } from "./FormField";
import { FormSelect } from "./FormSelect";

interface BaseFieldProps<T extends FieldValues, N extends FieldPath<T>> {
  control: Control<T>;
  name: N;
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
  /** Class for the surrounding `Field`; the control itself takes `className` where it has one. */
  fieldClassName?: string;
}

type Controlled = "name" | "value" | "defaultValue" | "onChange" | "onBlur" | "ref" | "id";
type InputProps = Omit<ComponentProps<typeof Input>, Controlled>;

/** Text-like `Input` bound to a string field. */
export function InputField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, fieldClassName, ...inputProps
}: BaseFieldProps<T, N> & InputProps) {
  return (
    <FormField control={control} name={name} label={label} description={description} id={id} className={fieldClassName}>
      {({ field, fieldState, id: fieldId }) => (
        <Input {...inputProps} {...field} id={fieldId} aria-invalid={fieldState.invalid || undefined} />
      )}
    </FormField>
  );
}

/**
 * `type="number"` input bound to a numeric field. `parse` turns what was typed into the stored
 * value (clamp, floor, fall back to a default) so the form never holds NaN.
 */
export function NumberField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, fieldClassName, parse = Number, ...inputProps
}: BaseFieldProps<T, N> & Omit<InputProps, "type"> & { parse?: (raw: string) => number }) {
  return (
    <FormField control={control} name={name} label={label} description={description} id={id} className={fieldClassName}>
      {({ field, fieldState, id: fieldId }) => (
        <Input
          {...inputProps}
          type="number"
          id={fieldId}
          name={field.name}
          ref={field.ref}
          onBlur={field.onBlur}
          value={String(field.value ?? "")}
          onChange={(event) => field.onChange(parse(event.target.value))}
          aria-invalid={fieldState.invalid || undefined}
        />
      )}
    </FormField>
  );
}

/** `Textarea` bound to a string field. */
export function TextareaField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, fieldClassName, ...props
}: BaseFieldProps<T, N> & Omit<ComponentProps<typeof Textarea>, Controlled>) {
  return (
    <FormField control={control} name={name} label={label} description={description} id={id} className={fieldClassName}>
      {({ field, fieldState, id: fieldId }) => (
        <Textarea {...props} {...field} id={fieldId} aria-invalid={fieldState.invalid || undefined} />
      )}
    </FormField>
  );
}

/** `FormSelect` bound to a string field. */
export function SelectField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, fieldClassName, options, placeholder, ariaLabel,
}: BaseFieldProps<T, N> & {
  options: { label: string; value: string }[];
  placeholder?: string;
  ariaLabel: string;
}) {
  return (
    <FormField control={control} name={name} label={label} description={description} id={id} className={fieldClassName}>
      {({ field }) => (
        <FormSelect
          ariaLabel={ariaLabel}
          value={field.value as string}
          options={options}
          placeholder={placeholder}
          onChange={field.onChange}
        />
      )}
    </FormField>
  );
}

/** Checkbox with its label on one row, bound to a boolean field. */
export function CheckboxField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, fieldClassName,
}: Pick<BaseFieldProps<T, N>, "control" | "name" | "fieldClassName"> & { label: ReactNode }) {
  return (
    <FormField control={control} name={name} className={fieldClassName}>
      {({ field }) => (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={Boolean(field.value)}
            onCheckedChange={(checked) => field.onChange(checked === true)}
            onBlur={field.onBlur}
            ref={field.ref}
          />
          {label}
        </label>
      )}
    </FormField>
  );
}

/** Segmented single-choice toggle bound to a string field. */
export function ToggleGroupField<T extends FieldValues, N extends FieldPath<T>>({
  control, name, label, description, id, fieldClassName, options, ariaLabel,
}: BaseFieldProps<T, N> & {
  options: { label: string; value: string }[];
  ariaLabel: string;
}) {
  return (
    <FormField control={control} name={name} label={label} description={description} id={id} className={fieldClassName}>
      {({ field, id: fieldId }) => (
        <ToggleGroup
          id={fieldId}
          size="sm"
          spacing={0}
          className="rounded-lg bg-muted/70 p-0.5"
          aria-label={ariaLabel}
          value={[field.value as string]}
          onValueChange={(value) => {
            const next = value[0];
            if (next) field.onChange(next);
          }}
        >
          {options.map((o) => (
            <ToggleGroupItem key={o.value} value={o.value} aria-label={o.label} className="rounded-md! px-3 aria-pressed:bg-background">
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </FormField>
  );
}
