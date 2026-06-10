import { Link } from "../ui/console";

interface InfoLinkProps {
  onFollow: () => void;
}

export function InfoLink({ onFollow }: InfoLinkProps) {
  return (
    <Link
      href="#"
      onClick={(event: any) => {
        event.preventDefault();
        onFollow();
      }}
    >
      Info
    </Link>
  );
}
