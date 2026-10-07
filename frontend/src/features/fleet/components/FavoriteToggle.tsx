import { Star } from "lucide-react";
import { Button } from "@vantyr/ui/components/button";
import { cn } from "@/lib/utils";

export function FavoriteToggle({ name, favorite, disabled, onToggle }: { name: string; favorite: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Favorite ${name}`}
      aria-pressed={favorite}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn("text-muted-foreground/60 hover:text-warning", favorite && "text-warning")}
    >
      <Star fill={favorite ? "currentColor" : "none"} />
    </Button>
  );
}
