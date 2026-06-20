import type { MouseEvent } from "react";
import { Link } from "../ui/console";

interface InfoLinkProps {
  onFollow: () => void;
}

export function InfoLink({ onFollow }: InfoLinkProps) {
  return (
    <Link
      href="#"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onFollow();
      }}
    >
      Info
    </Link>
  );
}
