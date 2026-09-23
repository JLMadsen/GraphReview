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
 * The wordmark's glyph: three components and the dependency edges between
 * them — the app's one idea, at 18px. Inline rather than a lucide icon so
 * the brand mark is GraphReview's own and not a stock pictogram.
 */
function GraphMark() {
  return (
    <span className="flex size-7 items-center justify-center rounded-[7px] bg-brand-muted ring-1 ring-inset ring-brand/30">
      <svg
        viewBox="0 0 24 24"
        className="size-4 text-brand"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M12 6.5v4M9.2 15.2l-2.6-2.1M14.8 15.2l2.6-2.1" opacity="0.75" />
        <circle cx="12" cy="4.5" r="2.4" fill="currentColor" stroke="none" />
        <circle cx="5" cy="17" r="2.4" fill="currentColor" stroke="none" />
        <circle cx="19" cy="17" r="2.4" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
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
          <div className="flex min-h-screen flex-col">
            <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/65">
              <div className="mx-auto flex h-14 max-w-7xl items-center gap-5 px-6">
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
              </div>
            </header>
            <main className="flex-1">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
