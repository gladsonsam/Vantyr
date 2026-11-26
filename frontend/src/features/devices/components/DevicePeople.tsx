import { Avatar, AvatarFallback } from "@vantyr/ui/components/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@vantyr/ui/components/popover";
import { HelpTip } from "@/components/common/HelpTip";
import type { DeviceRow } from "@/features/devices/lib/deviceModel";

const MAX_SHOWN = 3;

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

/** The people assigned to a device, owner first, as avatars and names. Roles live in the tooltip. */
export function DevicePeople({ device }: { device: DeviceRow }) {
  // Only an agent can say who is signed in; every other connection leaves it unknown.
  const agentConnected = device.connections.agent.state === "connected";
  const people = [...device.people].sort(
    (a, b) => Number(b.role === "owner") - Number(a.role === "owner"),
  );
  const shown = people.slice(0, MAX_SHOWN);
  const extra = people.slice(MAX_SHOWN);
  return (
    <div className="flex items-center gap-2" aria-label="Who uses this device">
      {people.length === 0 ? (
        <span className="text-sm text-muted-foreground">No one assigned</span>
      ) : people.length <= MAX_SHOWN ? (
        <ul className="flex items-center gap-4">
          {people.map(({ assignmentId, person, role }) => (
            <li
              key={assignmentId}
              title={role}
              aria-label={`${person.display_name}, ${role}`}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <Avatar size="sm">
                <AvatarFallback>{initials(person.display_name)}</AvatarFallback>
              </Avatar>
              {person.display_name}
            </li>
          ))}
        </ul>
      ) : (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={`${people.length} people use this device`}
                className="flex items-center gap-2 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            }
          >
            <span className="flex -space-x-1.5">
              {shown.map(({ assignmentId, person }) => (
                <Avatar key={assignmentId} size="sm">
                  <AvatarFallback>{initials(person.display_name)}</AvatarFallback>
                </Avatar>
              ))}
            </span>
            <span className="text-sm font-medium text-muted-foreground">+{extra.length}</span>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="w-56">
            <ul className="space-y-2 text-sm">
              {people.map(({ assignmentId, person, role }) => (
                <li key={assignmentId} className="flex items-center justify-between gap-3">
                  <span className="font-medium">{person.display_name}</span>
                  <span className="text-muted-foreground">{role}</span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <HelpTip label="About who uses it">
        {agentConnected
          ? "The agent can verify who is signed in, so that person’s rules apply while they are."
          : "Nobody can be verified on this device right now, so its device defaults apply to everyone. An owner is who it belongs to, not necessarily who is using it."}
      </HelpTip>
    </div>
  );
}
