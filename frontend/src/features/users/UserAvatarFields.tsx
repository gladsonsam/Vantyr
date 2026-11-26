import { useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useController, type Control } from "react-hook-form";
import { Upload } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { Spinner } from "@vantyr/ui/components/spinner";
import { InputField } from "@/components/common/form/fields";
import { cn } from "@/lib/utils";
import {
  encodeUserLucideIcon,
  parseUserLucideIcon,
  resizeImageFileToJpegDataUrl,
} from "./userAvatar";
import { PROFILE_LUCIDE_ICONS, PROFILE_LUCIDE_NAMES } from "./profileIcons";
import { DialogError } from "./UserDialogParts";
import { messageOr } from "./messageOr";
import type { ProfileValues } from "./userProfile";

interface UserAvatarFieldsProps {
  control: Control<ProfileValues>;
  /** Hint beside the username label (who may use it, what changing it does). */
  usernameHint: string;
  disabled?: boolean;
}

/** Full name, username and avatar (photo or icon) of one account. A photo that can't be read is reported right here. */
export function UserAvatarFields({ control, usernameHint, disabled }: UserAvatarFieldsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const { field: iconField } = useController({ control, name: "display_icon" });
  const icon = iconField.value;
  const setIcon = iconField.onChange;

  const onPhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPhotoError(null);
    if (!f.type.startsWith("image/")) {
      setPhotoError("That file isn't an image.");
      return;
    }
    setPhotoBusy(true);
    try {
      setIcon(await resizeImageFileToJpegDataUrl(f, 128, 0.82));
    } catch (err: unknown) {
      setPhotoError(messageOr(err, "Could not import photo"));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <InputField
          control={control}
          name="display_name"
          id="avatar-full-name"
          label="Full name"
          placeholder="e.g. Jane Doe"
          className="h-9"
          disabled={disabled}
          autoComplete="off"
          description="Shown in the top bar and user lists instead of the username. Optional."
        />
        <InputField
          control={control}
          name="username"
          id="avatar-username"
          label="Username"
          className="h-9"
          disabled={disabled}
          autoComplete="off"
          description={usernameHint}
        />
      </div>
      <div role="group" aria-labelledby={labelId} className="flex flex-col gap-3">
        <span id={labelId} className="text-sm font-medium">
          Avatar
        </span>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || photoBusy}
            onClick={() => fileRef.current?.click()}
          >
            {photoBusy ? <Spinner /> : <Upload />} Import photo
          </Button>
          {icon.trim() !== "" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setIcon("")}
            >
              Clear avatar
            </Button>
          )}
        </div>
        <DialogError prefix="Photo not used" message={photoError} />
        <div
          className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10"
          role="group"
          aria-label="Avatar icons"
        >
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
                disabled={disabled}
                onClick={() => setIcon(encoded)}
                className={cn(
                  "flex size-10 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  selected && "bg-primary/15 text-primary ring-2 ring-primary",
                )}
              >
                <Cmp size={22} strokeWidth={2} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
