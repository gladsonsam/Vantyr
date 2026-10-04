import {
  Bell,
  Briefcase,
  Building2,
  Camera,
  Code,
  Cpu,
  Database,
  Eye,
  Fingerprint,
  Globe,
  HardDrive,
  Key,
  Laptop,
  Lock,
  Monitor,
  Rocket,
  Server,
  Shield,
  Star,
  Terminal,
  User,
  UserCircle,
  Wifi,
  Wrench,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The avatar icons a user can pick, keyed by the Lucide name we persist.
 *
 * Deliberately an explicit map rather than `import * as LucideIcons`: a
 * namespace import defeats tree-shaking and pulls Lucide's entire icon set
 * (~530 kB) into the bundle just to resolve these few names at runtime.
 *
 * Callers must still handle a miss — stored avatars may name an icon that has
 * since been dropped from this list.
 */
export const PROFILE_LUCIDE_ICONS: Record<string, LucideIcon> = {
  User,
  UserCircle,
  Shield,
  Monitor,
  Laptop,
  Server,
  HardDrive,
  Briefcase,
  Building2,
  Wrench,
  Rocket,
  Star,
  Globe,
  Lock,
  Key,
  Eye,
  Camera,
  Cpu,
  Wifi,
  Terminal,
  Code,
  Database,
  Fingerprint,
  Bell,
  Zap,
};

/** Picker order for the avatar icon grid. */
export const PROFILE_LUCIDE_NAMES = Object.keys(PROFILE_LUCIDE_ICONS);
