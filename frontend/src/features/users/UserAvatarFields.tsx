import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useController, type Control } from "react-hook-form";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputField } from "@/components/common/form/fields";
import { cn } from "@/lib/utils";
import { encodeUserLucideIcon, parseUserLucideIcon, resizeImageFileToJpegDataUrl } from "./userAvatar";
import { PROFILE_LUCIDE_ICONS, PROFILE_LUCIDE_NAMES } from "./profileIcons";
import type { ProfileValues } from "./userProfile";

interface UserAvatarFieldsProps {
  control: Control<ProfileValues>;
  idLabel: string;
  isNarrow: boolean;
  onImportError?: (message: string) => void;
  /** Skip the username validation message (the form disables its save button instead). */
  hideErrors?: boolean;
}

export function UserAvatarFields({ control, idLabel, isNarrow, onImportError, hideErrors }: UserAvatarFieldsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const { field: iconField } = useController({ control, name: "display_icon" });
  const icon = iconField.value;
  const setIcon = iconField.onChange;

  const onPhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f?.type.startsWith("image/")) return;
    setPhotoBusy(true);
    try {
      const dataUrl = await resizeImageFileToJpegDataUrl(f, 128, 0.82);
      setIcon(dataUrl);
    } catch (err: unknown) {
      onImportError?.(String((err as { message?: string })?.message || "Could not import photo"));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className={isNarrow ? "grid grid-cols-1 gap-5" : "grid grid-cols-1 gap-5 md:grid-cols-2"}>
        <InputField
          control={control}
          name="display_name"
          id="avatar-full-name"
          label="Full name"
          placeholder="e.g. Jane Doe"
          className="h-9"
          description="Shown in the top bar and user lists. Optional; sign-in still uses username below."
        />
        <InputField control={control} name="username" id="avatar-username" label="Username" className="h-9" description={idLabel} hideError={hideErrors} />
      </div>
      <Field>
        <FieldLabel>Avatar</FieldLabel>
        <div className="flex flex-col gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(ev) => void onPhotoChange(ev)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
              <Upload /> Import photo
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIcon("")}>
              Clear avatar
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Icon library</p>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10" role="group" aria-label="Icon library">
            {PROFILE_LUCIDE_NAMES.map((name) => {
              const Cmp = PROFILE_LUCIDE_ICONS[name];
              if (!Cmp) return null;
              const encoded = encodeUserLucideIcon(name);
              const selected = icon === encoded || parseUserLucideIcon(icon) === name;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={`Use ${name} icon`}
                  aria-pressed={selected}
                  onClick={() => setIcon(encoded)}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "bg-primary/15 text-primary ring-2 ring-primary",
                  )}
                >
                  <Cmp size={22} strokeWidth={2} />
                </button>
              );
            })}
          </div>
        </div>
        <FieldDescription>
          Choose a Lucide icon or import a photo (JPEG/PNG/WebP/GIF). Cleared avatars use initials from your full name or username.
        </FieldDescription>
      </Field>
    </div>
  );
}
