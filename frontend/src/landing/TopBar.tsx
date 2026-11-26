import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ArrowButton } from "./ArrowButton";

type MenuItem = { label: string; description: string; href: string };
type NavEntry = { label: string; href: string } | { label: string; items: MenuItem[] };

const GITHUB_URL = "https://github.com/gladsonsam/Vantyr";
const WIKI_URL = `${GITHUB_URL}/wiki`;

const NAV: NavEntry[] = [
  {
    label: "Features",
    items: [
      {
        label: "Live desktop",
        description: "Watch and control a screen in real time",
        href: "#features",
      },
      {
        label: "Recall",
        description: "Search what was on screen, encrypted at rest",
        href: "#features",
      },
      {
        label: "Activity history",
        description: "App and website timelines for every device",
        href: "#features",
      },
      {
        label: "Fleet rules",
        description: "Alerts, blocking and scheduled scripts",
        href: "#features",
      },
    ],
  },
  {
    label: "Resources",
    items: [
      { label: "Documentation", description: "Deploy, configure and use Vantyr", href: WIKI_URL },
      { label: "GitHub", description: "Source code and issues", href: GITHUB_URL },
      {
        label: "Releases",
        description: "Downloads and changelogs",
        href: `${GITHUB_URL}/releases`,
      },
      { label: "Live demo", description: "The real dashboard, simulated devices", href: "/demo" },
    ],
  },
  { label: "FAQ", href: "#faq" },
];

const NAV_BUTTON =
  "flex items-center gap-1 rounded-full px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground max-[1200px]:px-3";

function Dropdown({ entry }: { entry: Extract<NavEntry, { items: MenuItem[] }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={NAV_BUTTON}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {entry.label}
        <ChevronDown className="size-4" aria-hidden />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="absolute top-full left-0 w-72 pt-2"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-[var(--landing-frame)] p-2 shadow-lg">
              {entry.items.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-4 py-3 transition-colors hover:bg-muted"
                >
                  <div className="text-sm font-medium text-foreground">{item.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{item.description}</div>
                </a>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MobileGroup({ entry }: { entry: Extract<NavEntry, { items: MenuItem[] }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-foreground/10">
      <button
        type="button"
        className="flex w-full items-center justify-between py-4 text-base font-medium"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {entry.label}
        <motion.div animate={{ rotate: open ? 180 : 0 }}>
          <ChevronDown className="size-5" aria-hidden />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="pb-3">
              {entry.items.map((item) => (
                <a key={item.label} href={item.href} className="block py-2.5">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-xs text-muted-foreground">{item.description}</div>
                </a>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const FLARE = "pointer-events-none absolute top-0 text-[var(--landing-frame)] max-[850px]:hidden";

/**
 * Tab that hangs from the top of the frame: square top corners, 32px bottom corners and concave
 * flares that fuse it into the frame. Below 850px it becomes a full-width drawer.
 */
export function TopBar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="fixed top-2.5 left-1/2 z-[9998] w-full max-w-5xl -translate-x-1/2 rounded-b-[2rem] bg-[var(--landing-frame)] shadow-2xl shadow-black/20 max-[1200px]:max-w-2xl max-[850px]:top-0 max-[850px]:right-0 max-[850px]:left-0 max-[850px]:max-w-none max-[850px]:translate-x-0 max-[850px]:overflow-hidden max-[850px]:rounded-none max-[850px]:rounded-b-[2rem]">
      <div className="flex h-20 items-center justify-between px-4 max-[850px]:h-[72px] max-[850px]:px-6">
        <a href="/" className="ml-4 flex items-center gap-2 max-[850px]:ml-0">
          <img src="/logo.svg" alt="" className="size-6" />
          <span className="text-lg font-semibold tracking-tight max-[1200px]:hidden max-[850px]:inline">
            Vantyr
          </span>
        </a>

        <nav className="flex items-center gap-1 max-[1200px]:gap-0 max-[850px]:hidden">
          {NAV.map((entry) =>
            "items" in entry ? (
              <Dropdown key={entry.label} entry={entry} />
            ) : (
              <a key={entry.label} href={entry.href} className={NAV_BUTTON}>
                {entry.label}
              </a>
            ),
          )}
        </nav>

        <div className="flex items-center gap-4 max-[850px]:hidden">
          <a
            href={GITHUB_URL}
            className="text-sm font-medium text-foreground/80 transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <ArrowButton href="/demo">Live demo</ArrowButton>
        </div>

        <button
          type="button"
          className="hidden size-10 items-center justify-center max-[850px]:flex"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <div className="relative flex h-4 w-8 flex-col justify-between">
            <motion.span
              className="block h-0.5 w-full origin-center rounded-full bg-foreground"
              animate={{ y: menuOpen ? 4.5 : 0, rotate: menuOpen ? 45 : 0 }}
            />
            <motion.span
              className="block h-0.5 w-full origin-center rounded-full bg-foreground"
              animate={{ y: menuOpen ? -9.5 : 0, rotate: menuOpen ? -45 : 0 }}
            />
          </div>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {menuOpen ? (
          <motion.div
            className="hidden overflow-hidden max-[850px]:block"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <div className="px-6 pb-4">
              <nav>
                {NAV.map((entry, index) =>
                  "items" in entry ? (
                    <MobileGroup key={entry.label} entry={entry} />
                  ) : (
                    <a
                      key={entry.label}
                      href={entry.href}
                      onClick={() => setMenuOpen(false)}
                      className={`flex items-center justify-between py-4 text-base font-medium ${index < NAV.length - 1 ? "border-b border-foreground/10" : ""}`}
                    >
                      {entry.label}
                    </a>
                  ),
                )}
              </nav>
              <div className="flex items-center justify-between pt-8 pb-2">
                <a href={GITHUB_URL} className="text-base font-medium">
                  GitHub
                </a>
                <ArrowButton href="/demo" radius="rounded-2xl">
                  Live demo
                </ArrowButton>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <svg
        className={`${FLARE} -left-[49px] rotate-180`}
        width="50"
        height="50"
        viewBox="0 0 50 50"
        fill="none"
        aria-hidden
      >
        <path d="M0 0C0 37.3 9 50 50 50H0V0Z" fill="currentColor" />
      </svg>
      <svg
        className={`${FLARE} -right-[49px] rotate-90`}
        width="50"
        height="50"
        viewBox="0 0 50 50"
        fill="none"
        aria-hidden
      >
        <path d="M0 0C0 37.3 9 50 50 50H0V0Z" fill="currentColor" />
      </svg>
    </header>
  );
}
