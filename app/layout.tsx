import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MainNav } from "./main-nav";
import "./globals.css";

// Geist is loaded from the `geist` npm package's bundled woff2 files (via
// next/font/local), never from Google Fonts, so neither the build nor the
// browser needs internet access. The package names its CSS variables
// `--font-geist-sans`/`--font-geist-mono` — deliberately NOT the theme's
// `--font-sans`/`--font-mono`: globals.css maps the theme tokens onto them
// *plus a system fallback stack*. See the comment on `--font-sans` there.

export const metadata: Metadata = {
  title: "GraphReview",
  description:
    "A locally-run tool for reviewing GitHub pull requests against a codebase's component graph.",
};

/**
 * The wordmark's glyph, identical to app/icon.svg: an area of components on
 * a blueprint grid, with a change reaching out of it to a component that
 * needs a look — the impact check, at 28px. Fixed colours (not theme tokens)
 * so it matches the favicon in both themes. Explorations that led here live
 * in docs/testing/logos/.
 */
function GraphMark() {
  return (
    <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#123458" />
      <path
        d="M8 0V32M16 0V32M24 0V32M0 8H32M0 16H32M0 24H32"
        stroke="#fff"
        strokeOpacity=".08"
        strokeWidth=".6"
      />
      <rect
        x="4"
        y="4"
        width="16.5"
        height="16.5"
        rx="4"
        fill="#567bf7"
        fillOpacity=".4"
        stroke="#9db6ff"
        strokeWidth="1"
        strokeDasharray="2 1.5"
      />
      <path
        d="M8.5 8.5L15.5 15.5M8.5 15.5H15.5M8.5 8.5V15.5"
        stroke="#fff"
        strokeOpacity=".7"
        strokeWidth="1.3"
      />
      <circle cx="8.5" cy="8.5" r="2.1" fill="#fff" />
      <circle cx="8.5" cy="15.5" r="2.1" fill="#fff" />
      <circle cx="15.5" cy="15.5" r="2.4" fill="#fff" />
      <circle
        cx="24.5"
        cy="24.5"
        r="5.2"
        fill="none"
        stroke="#f2b84b"
        strokeOpacity=".4"
        strokeWidth="1.1"
      />
      <path d="M15.5 15.5L21.9 21.9" stroke="#f2b84b" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24.5" cy="24.5" r="2.7" fill="#123458" stroke="#f2b84b" strokeWidth="1.8" />
    </svg>
  );
}

export default function RootLayout({
  children,
  nav,
}: Readonly<{
  children: React.ReactNode;
  /** The `@nav` slot: the open repo's name, source and status — empty outside a repo. */
  nav: React.ReactNode;
}>) {
  return (
    // The font variables belong on <html>, not <body>: globals.css applies
    // `font-sans` to the html element, and a `var()` that resolves nowhere
    // invalidates the whole `font-family` declaration — the rest of the
    // fallback list does not rescue it. With the classes on <body> only,
    // <html> had no --font-geist-sans, so the app rendered every page in the
    // browser's default *serif*. (The system stack in globals.css is the
    // second line of defence.)
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="antialiased">
        <TooltipProvider>
          {/* `group/app`: the bar spans the window when the page is an
              edge-to-edge analysis surface (`data-wide-shell`, the Graph
              tab), the same `:has()` switch the repo shell uses. */}
          <div className="group/app flex min-h-screen flex-col">
            <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/65">
              <div className="mx-auto flex h-12 max-w-7xl items-center gap-5 px-6 group-has-[[data-wide-shell]]/app:max-w-none group-has-[[data-wide-shell]]/app:px-4">
                <Link
                  href="/"
                  className="group flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <GraphMark />
                  <span className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
                    Graph
                    <span className="text-foreground/55 transition-colors group-hover:text-foreground/80">
                      Review
                    </span>
                  </span>
                </Link>
                <span
                  className="h-4 w-px shrink-0 bg-border"
                  aria-hidden
                />
                <MainNav />
                <div className="ml-auto flex min-w-0 items-center">{nav}</div>
              </div>
            </header>
            <main className="flex-1">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
