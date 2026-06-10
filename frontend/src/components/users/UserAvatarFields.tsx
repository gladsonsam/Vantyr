import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { SpaceBetween, ColumnLayout, FormField, Input, Button, Box } from "../ui/console";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { encodeUserLucideIcon, parseUserLucideIcon, resizeImageFileToJpegDataUrl } from "../../lib/userAvatar";

const PROFILE_LUCIDE_NAMES = [
  "User",
  "UserCircle",
  "Shield",
  "Monitor",
  "Laptop",
  "Server",
  "HardDrive",
  "Briefcase",
  "Building2",
  "Wrench",
  "Rocket",
  "Star",
  "Globe",
  "Lock",
  "Key",
  "Eye",
  "Camera",
  "Cpu",
  "Wifi",
  "Terminal",
  "Code",
  "Database",
  "Fingerprint",
  "Bell",
  "Zap",
];

export interface UserAvatarFieldsProps {
  fullName: string;
  setFullName: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  icon: string;
  setIcon: (v: string) => void;
  idLabel: string;
  isNarrow: boolean;
  onImportError?: (message: string) => void;
}

export function UserAvatarFields({
  fullName,
  setFullName,
  username,
  setUsername,
  icon,
  setIcon,
  idLabel,
  isNarrow,
  onImportError,
}: UserAvatarFieldsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

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

  const grid = (
    <div className="vantyr-user-icon-grid">
      {PROFILE_LUCIDE_NAMES.map((name) => {
        const Cmp = (LucideIcons as unknown as Record<string, LucideIcon>)[name];
        if (!Cmp) return null;
        const encoded = encodeUserLucideIcon(name);
        const selected = icon === encoded || parseUserLucideIcon(icon) === name;
        return (
          <button
            key={name}
            type="button"
            className={`vantyr-user-lucide-pick${selected ? " vantyr-user-lucide-pick--selected" : ""}`}
            title={name}
            aria-label={`Use ${name} icon`}
            aria-pressed={selected}
            onClick={() => setIcon(encoded)}
          >
            <Cmp size={22} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );

  return (
    <SpaceBetween size="m">
      <ColumnLayout columns={isNarrow ? 1 : 2}>
        <FormField
          label="Full name"
          description="Shown in the top bar and user lists. Optional; sign-in still uses username below."
        >
          <Input
            value={fullName}
            onChange={({ detail }) => setFullName(detail.value)}
            placeholder="e.g. Jane Doe"
          />
        </FormField>
        <FormField label="Username" description={idLabel}>
          <Input value={username} onChange={({ detail }) => setUsername(detail.value)} />
        </FormField>
      </ColumnLayout>
      <FormField
        label="Avatar"
        description="Choose a Lucide icon or import a photo (JPEG/PNG/WebP/GIF). Cleared avatars use initials from your full name or username."
      >
        <SpaceBetween size="m">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(ev) => void onPhotoChange(ev)}
          />
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="upload" onClick={() => fileRef.current?.click()} loading={photoBusy}>
              Import photo
            </Button>
            <Button variant="link" onClick={() => setIcon("")}>
              Clear avatar
            </Button>
          </SpaceBetween>
          <Box variant="awsui-key-label" margin={{ top: "xs" }}>
            Icon library
          </Box>
          {grid}
        </SpaceBetween>
      </FormField>
    </SpaceBetween>
  );
}
