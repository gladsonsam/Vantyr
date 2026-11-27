import { ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import BorderGlow from "@/components/react-bits/BorderGlow";
import DecryptedText from "@/components/react-bits/DecryptedText";
import GlareHover from "@/components/react-bits/GlareHover";
import ScrollReveal from "@/components/react-bits/ScrollReveal";
import SpotlightCard from "@/components/react-bits/SpotlightCard";
import SplitText from "@/components/react-bits/SplitText";

import { ArrowButton } from "./ArrowButton";
import { Backdrop } from "./Backdrop";
import { Frame } from "./Frame";
import { TopBar } from "./TopBar";

const GITHUB_URL = "https://github.com/gladsonsam/Vantyr";
const WIKI_URL = `${GITHUB_URL}/wiki`;

// Light, lime-accented theme scoped to the landing page (the dashboard stays dark).
const LIME = "#20dd8f";
const THEME = {
  "--background": "#141414",
  "--landing-frame": "#000000",
  "--landing-accent": LIME,
  "--foreground": "#fafafa",
  "--card": "#171717",
  "--card-foreground": "#fafafa",
  "--muted-foreground": "#a3a3a3",
  "--muted": "#171717",
  "--border": "#262626",
  "--primary": LIME,
  "--primary-foreground": "#0a0a0a",
} as CSSProperties;
const BRAND_GLOW = [LIME, "#2bb6c9", "#7c6cf0"];

const steps = [
  {
    title: "Start the server",
    body: "Run Vantyr and Postgres with Docker Compose on a machine you control.",
  },
  {
    title: "Enroll your devices",
    body: "Install the agent on Windows or Linux. New devices wait in the dashboard until you approve them.",
  },
  {
    title: "Watch and act",
    body: "Open a live desktop, scroll back through activity, search Recall, and set rules for the fleet.",
  },
];

const faqs = [
  {
    q: "Does it cost anything?",
    a: "No. Vantyr is MIT licensed and you host it yourself, so there are no plans, seats or accounts with us.",
  },
  {
    q: "Where does the data go?",
    a: "To your own Postgres database and disk. Recall screenshots and thumbnails are encrypted at rest, and encrypted backups are supported.",
  },
  {
    q: "Which devices can I monitor?",
    a: "Windows and Linux. The Windows agent is a desktop app, and the Linux agent runs headless. Which features work depends on the platform and the permissions you grant.",
  },
  {
    q: "Can I try it without installing anything?",
    a: "Yes. The live demo runs the real dashboard against simulated devices in your browser.",
  },
];

function Tile({
  className = "",
  children,
  color = LIME,
}: {
  className?: string;
  children: ReactNode;
  color?: string;
}) {
  return (
    <SpotlightCard theme="dark" spotlightColor={color} intensity={0.35} className={className}>
      {children}
    </SpotlightCard>
  );
}

function TileText({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="text-xl font-medium tracking-tight">{title}</h3>
      <p className="mt-3 max-w-sm leading-relaxed text-muted-foreground">{children}</p>
    </>
  );
}

export function LandingPage() {
  return (
    // The app shell locks the body to the viewport, so the landing page scrolls itself.
    <div
      style={THEME}
      className="relative isolate h-full scroll-smooth overflow-y-auto bg-background text-foreground"
    >
      <Backdrop />
      <Frame />
      <TopBar />

      <main>
        <section className="relative isolate overflow-hidden">
          <div className="relative mx-auto max-w-4xl px-6 pb-24 pt-44 text-center sm:pt-52">
            {/* Soft scrim so the copy never sits directly on the bright dither. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-16 top-24 bottom-4 -z-10 bg-[radial-gradient(closest-side,rgb(20_20_20/0.92),rgb(20_20_20/0.78)_60%,transparent)]"
            />
            <h1 className="text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.035em] text-white [text-shadow:0_2px_24px_rgb(0_0_0/0.55)] sm:text-[4.5rem]">
              <SplitText
                tag="span"
                text="Monitor every device from a server you own."
                splitType="words"
                effect="blur"
                trigger="load"
                duration={0.9}
                delay={60}
                textAlign="center"
              />
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-balance text-lg leading-relaxed text-white/90 [text-shadow:0_1px_16px_rgb(0_0_0/0.6)] sm:text-xl">
              Vantyr shows live desktops, activity timelines and searchable screen history for
              Windows and Linux machines. Everything stays on your hardware.
            </p>
            <div className="mt-11 flex flex-wrap items-center justify-center gap-x-8 gap-y-5">
              <ArrowButton href="/demo">Try the live demo</ArrowButton>
              <a
                href={GITHUB_URL}
                className="font-medium text-white/90 underline decoration-white/30 underline-offset-[6px] transition-colors hover:text-white hover:decoration-white"
              >
                View on GitHub
              </a>
            </div>
          </div>

          <div className="mx-auto max-w-6xl px-6 pb-20">
            <BorderGlow
              borderRadius={20}
              backgroundColor="#141414"
              glowColor="160 70 55"
              colors={BRAND_GLOW}
              fillOpacity={0.25}
            >
              <img
                src="/landing/dashboard.webp"
                alt="The Vantyr dashboard showing a fleet of devices"
                className="block w-full rounded-[20px]"
              />
            </BorderGlow>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-28">
          <ScrollReveal
            mode="scrub"
            effect="rise"
            enableBlur
            baseOpacity={0.12}
            textClassName="text-3xl font-semibold leading-snug tracking-tight sm:text-5xl"
          >
            Every capture and keystroke stays on a server you run. Nothing is sent to us.
          </ScrollReveal>
        </section>

        <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-16">
          <h2 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            What you can do from one dashboard
          </h2>
          <div className="mt-14 grid gap-6 lg:grid-cols-6">
            <Tile className="!p-0 lg:col-span-4">
              <div className="p-8 pb-6">
                <TileText title="Live desktop">
                  H.264 streaming with an MJPEG fallback, and desktop audio on Windows.
                </TileText>
              </div>
              <GlareHover
                width="100%"
                height="auto"
                background="transparent"
                borderRadius="0"
                borderColor="transparent"
                glareColor="#ffffff"
                glareOpacity={0.18}
              >
                <img
                  src="/landing/live.webp"
                  loading="lazy"
                  alt="Live view of a remote desktop"
                  className="block w-full"
                />
              </GlareHover>
            </Tile>

            <Tile className="lg:col-span-2" color="#2bb6c9">
              <div className="flex h-full flex-col">
                <TileText title="Recall">
                  Replay screen history and search the text that was on screen. Stored encrypted.
                </TileText>
                <div className="mt-auto rounded-xl border border-border bg-background/60 p-4 text-sm leading-relaxed">
                  <DecryptedText
                    text="Budget review — Q3 forecast.xlsx"
                    animateOn="view"
                    sequential
                    revealDirection="start"
                    speed={45}
                    loop
                    loopDelay={4000}
                    parentClassName="text-foreground"
                    encryptedClassName="text-muted-foreground"
                  />
                </div>
              </div>
            </Tile>

            <Tile className="lg:col-span-2">
              <TileText title="Remote control">
                Mouse, keyboard, clipboard, files, terminal and scripts, within each device's
                permissions.
              </TileText>
            </Tile>

            <Tile className="lg:col-span-2">
              <TileText title="Activity history">
                App and website timelines, AFK transitions and keystrokes, with analytics for every
                device.
              </TileText>
            </Tile>

            <Tile className="lg:col-span-2" color="#2bb6c9">
              <TileText title="Fleet rules">
                Alerts, app blocking, internet access and scheduled scripts across every device.
              </TileText>
            </Tile>
          </div>
        </section>

        <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-28">
          <h2 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Running in three steps
          </h2>
          <ol className="mt-14 grid gap-6 md:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title}>
                <SpotlightCard
                  theme="dark"
                  spotlightColor={LIME}
                  intensity={0.3}
                  className="h-full"
                >
                  <span className="text-5xl font-semibold" style={{ color: LIME }}>
                    {index + 1}
                  </span>
                  <h3 className="mt-6 text-xl font-medium tracking-tight">{step.title}</h3>
                  <p className="mt-3 leading-relaxed text-muted-foreground">{step.body}</p>
                </SpotlightCard>
              </li>
            ))}
          </ol>
          <pre className="mt-10 overflow-x-auto rounded-2xl border border-border bg-card p-6 text-sm leading-relaxed">
            <code>
              {
                "cp .env.example .env  # set POSTGRES_PASSWORD and ADMIN_PASSWORD\ndocker compose up -d"
              }
            </code>
          </pre>
        </section>

        <section id="faq" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-24">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-20">
            <div className="lg:sticky lg:top-32 lg:self-start">
              <h2 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Common questions
              </h2>
              <p className="mt-5 max-w-sm leading-relaxed text-muted-foreground">
                Anything else you want to know before you install it? Ask on GitHub and we will
                answer there.
              </p>
              <div className="mt-8">
                <ArrowButton href={`${GITHUB_URL}/issues`}>Ask a question</ArrowButton>
              </div>
            </div>
            <div className="divide-y divide-border rounded-3xl border border-border bg-card/70 px-8 backdrop-blur-sm">
              {faqs.map((item) => (
                <details key={item.q} className="group py-6">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-lg font-medium [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="relative mt-24 bg-black pt-16 pb-14 max-[850px]:rounded-t-[2rem]">
        {/* Concave flares: the footer's top edge curves up into the side frame, like the nav tab. */}
        <svg
          aria-hidden
          className="pointer-events-none absolute bottom-full left-2.5 text-[var(--landing-frame)] max-[850px]:hidden"
          width="50"
          height="50"
          viewBox="0 0 50 50"
          fill="none"
        >
          <path d="M0 0C0 37.3 9 50 50 50H0V0Z" fill="currentColor" />
        </svg>
        <svg
          aria-hidden
          className="pointer-events-none absolute bottom-full right-2.5 -scale-x-100 text-[var(--landing-frame)] max-[850px]:hidden"
          width="50"
          height="50"
          viewBox="0 0 50 50"
          fill="none"
        >
          <path d="M0 0C0 37.3 9 50 50 50H0V0Z" fill="currentColor" />
        </svg>

        <div className="mx-auto max-w-5xl px-6">
          <div className="flex flex-col gap-12 md:flex-row md:justify-between">
            <div className="max-w-xs">
              <a
                href="/"
                className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"
              >
                <img src="/logo.svg" alt="" className="size-6" />
                Vantyr
              </a>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Self-hosted monitoring and remote desktop for Windows and Linux.
              </p>
            </div>
            <nav className="grid grid-cols-2 gap-x-14 gap-y-8 text-sm sm:grid-cols-3">
              <FooterColumn
                title="Product"
                links={[
                  { label: "Live demo", href: "/demo" },
                  { label: "Features", href: "#features" },
                  { label: "How it works", href: "#how-it-works" },
                  { label: "FAQ", href: "#faq" },
                ]}
              />
              <FooterColumn
                title="Resources"
                links={[
                  { label: "Documentation", href: WIKI_URL },
                  { label: "GitHub", href: GITHUB_URL },
                  { label: "Releases", href: `${GITHUB_URL}/releases` },
                ]}
              />
              <FooterColumn
                title="Project"
                links={[
                  { label: "MIT license", href: `${GITHUB_URL}/blob/main/LICENSE` },
                  { label: "Security policy", href: `${GITHUB_URL}/blob/main/SECURITY.md` },
                  { label: "Report an issue", href: `${GITHUB_URL}/issues` },
                ]}
              />
            </nav>
          </div>
          <div className="mt-16 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:justify-between">
            <span>MIT licensed.</span>
            <a href={GITHUB_URL} className="transition-colors hover:text-foreground">
              github.com/gladsonsam/Vantyr
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <div className="text-muted-foreground">{title}</div>
      <ul className="mt-4 space-y-3 font-medium">
        {links.map((link) => (
          <li key={link.label}>
            <a href={link.href} className="transition-colors hover:text-[var(--landing-accent)]">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
