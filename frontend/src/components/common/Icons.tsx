import type { SVGProps } from "react";

export const VI = {
  logo: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" {...p}>
      <path d="M2 2h5.5v2.6H4.6V8H2V2z" fill="currentColor" />
      <path d="M18 2h-5.5v2.6h2.9V8H18V2z" fill="currentColor" />
      <path d="M18 18h-5.5v-2.6h2.9V12H18v6z" fill="currentColor" opacity=".45" />
      <circle cx="10" cy="10" r="1.6" fill="currentColor" />
    </svg>
  ),
  grid: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
    </svg>
  ),
  agents: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="7" cy="7" r="3" />
      <path d="M2.5 17a4.5 4.5 0 0 1 9 0" />
      <path d="M14 4.2a3 3 0 0 1 0 5.6M15.5 17a4.5 4.5 0 0 0-3-4.2" />
    </svg>
  ),
  alerts: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.5l8 14.5H2L10 2.5z" />
      <path d="M10 8v4M10 14.5v.1" />
    </svg>
  ),
  audit: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
      <path d="M7 7h6M7 10.5h6M7 14h4" />
    </svg>
  ),
  screen: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="3.5" width="15" height="10" rx="2" />
      <path d="M7 17h6M10 13.5V17" />
    </svg>
  ),
  session: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5V10l3 2" />
    </svg>
  ),
  timeline: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 6h9M3 14h6" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="11" cy="14" r="2" />
    </svg>
  ),
  search: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M17.5 17.5l-4-4" />
    </svg>
  ),
  refresh: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M16.5 9a6.5 6.5 0 1 0-1 3.9M16.5 9V4.5m0 4.5h-4.5" />
    </svg>
  ),
  play: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="currentColor" {...p}>
      <path d="M6 4.5l9 5.5-9 5.5v-11z" />
    </svg>
  ),
  ctrl: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4.5 2.5l11 7.5-4.5 1.3L9 16.5 4.5 2.5z" />
    </svg>
  ),
  log: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 5.5h13M3.5 10h9M3.5 14.5h5" />
    </svg>
  ),
  more: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="currentColor" {...p}>
      <circle cx="4.5" cy="10" r="1.6" />
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="15.5" cy="10" r="1.6" />
    </svg>
  ),
  plus: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  ),
  lock: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="4.5" y="9" width="11" height="8.5" rx="2" />
      <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" />
    </svg>
  ),
  warn: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.5l8 15H2l8-15z" />
      <path d="M10 8v4M10 14.5v.1" />
    </svg>
  ),
  chevR: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7.5 4.5l5.5 5.5-5.5 5.5" />
    </svg>
  ),
  chevD: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4.5 7.5l5.5 5.5 5.5-5.5" />
    </svg>
  ),
  sort: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M8 5l-3.5 3.5L8 12M4.5 8.5h11M12 8l3.5 3.5L12 15M15.5 11.5h-11" />
    </svg>
  ),
  window: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 7.5h15" />
    </svg>
  ),
  shield: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.5l6 2.2v5c0 4-2.7 6.5-6 7.8-3.3-1.3-6-3.8-6-7.8v-5L10 2.5z" />
      <path d="M7.5 10l1.8 1.8 3.2-3.6" />
    </svg>
  ),
  list: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 5h10M7 10h10M7 15h10" />
      <circle cx="3.5" cy="5" r="1" fill="currentColor" />
      <circle cx="3.5" cy="10" r="1" fill="currentColor" />
      <circle cx="3.5" cy="15" r="1" fill="currentColor" />
    </svg>
  ),
  panel: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M8 3.5v13" />
    </svg>
  ),
  x: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  ),
  bell: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5c0 4-1.5 5.5-1.5 5.5h12s-1.5-1.5-1.5-5.5A4.5 4.5 0 0 0 10 2.5z" />
      <path d="M8.5 16a1.7 1.7 0 0 0 3 0" />
    </svg>
  ),
  arrowL: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M11 5l-5 5 5 5M6 10h9" />
    </svg>
  ),
  globe: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c-2.2 2.3-2.2 12.7 0 15M10 2.5c2.2 2.3 2.2 12.7 0 15" />
    </svg>
  ),
  keyboard: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="5" width="16" height="10" rx="2" />
      <path d="M5 8h.01M8 8h.01M11 8h.01M14 8h.01M6.5 11.5h7" />
    </svg>
  ),
  ban: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...p}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M4.8 4.8l10.4 10.4" />
    </svg>
  ),
  camera: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2.5" y="5.5" width="15" height="10" rx="2" />
      <path d="M7 5.5l1.3-2h3.4L13 5.5" />
      <circle cx="10" cy="10.5" r="2.6" />
    </svg>
  ),
  file: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M5 2.5h6l4 4v11H5V2.5z" />
      <path d="M11 2.5v4h4" />
    </svg>
  ),
  sliders: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="7" cy="14" r="2" />
    </svg>
  ),
  dl: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 3v9M6 8.5l4 4 4-4M4 16h12" />
    </svg>
  ),
  expand: (p: SVGProps<SVGSVGElement> = {}) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6" />
    </svg>
  ),
};
