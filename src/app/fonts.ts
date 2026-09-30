import localFont from "next/font/local";

/**
 * Typefaces are vendored into the repo and loaded with next/font/local rather
 * than next/font/google on purpose. This is a self-hosted product that people
 * build behind restrictive networks and inside Docker — a build step that has to
 * reach fonts.gstatic.com is a build that fails for them. Local files also mean
 * a running instance never makes a third-party request, which is the whole
 * premise of the app.
 *
 * Roles:
 *   display — Fraunces. Chosen because the type scale spans 11px to 88px and
 *             Fraunces carries a true optical-size axis (opsz 9–144), so the
 *             large net-worth figure and a small card title get genuinely
 *             different letterforms instead of one outline scaled up and down.
 *             Its high-contrast engraved cut suits a "coffer" better than the
 *             Georgia fallback it replaces, whose default old-style numerals
 *             had to be overridden with lining-nums to be readable as money.
 *   sans    — IBM Plex Sans. Drawn for technical products; the right register
 *             for an audience that runs its own Postgres.
 *   mono    — IBM Plex Mono. Ledger columns, account masks, tokens.
 */

export const displaySerif = localFont({
  src: [{ path: "./fonts/fraunces-latin.woff2", weight: "300 700", style: "normal" }],
  variable: "--font-display",
  display: "swap",
  // Georgia keeps the metrics close while the webfont loads.
  fallback: ["Georgia", "Times New Roman", "serif"],
  adjustFontFallback: false,
});

export const sans = localFont({
  src: [
    { path: "./fonts/plex-sans-latin.woff2", weight: "100 700", style: "normal" },
    { path: "./fonts/plex-sans-latin-ext.woff2", weight: "100 700", style: "normal" },
  ],
  variable: "--font-sans-loaded",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: false,
});

export const mono = localFont({
  src: [
    { path: "./fonts/plex-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-mono-400-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plex-mono-500-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plex-mono-500-latin-ext.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono-loaded",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  adjustFontFallback: false,
});

export const fontClassNames = `${displaySerif.variable} ${sans.variable} ${mono.variable}`;
