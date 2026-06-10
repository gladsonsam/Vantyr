import { Badge } from "../ui/console";

interface LiveBadgeProps {
  variant?: "online" | "active" | "streaming";
}

export function LiveBadge({ variant = "online" }: LiveBadgeProps) {
  const config = {
    online: { color: "green" as const, text: "LIVE" },
    active: { color: "blue" as const, text: "ACTIVE" },
    streaming: { color: "red" as const, text: "STREAMING" },
  };

  const { color, text } = config[variant];

  return (
    <Badge color={color}>
      <span className="vantyr-pulse">{text}</span>
    </Badge>
  );
}

interface CountBadgeProps {
  count: number;
  label?: string;
}

export function CountBadge({ count, label }: CountBadgeProps) {
  const color = count > 0 ? "blue" : "grey";
  const text = label ? `${count} ${label}` : count.toString();
  return <Badge color={color}>{text}</Badge>;
}
