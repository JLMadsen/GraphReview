"use client";

// Persistent top-nav links (Repos/Settings destinations).
//
// Split out of app/layout.tsx purely so the active-route indicator can read
// `usePathname()` — a client-only hook. The layout itself stays a server
// component; this renders nothing but links (and, inside a repo, the
// layout prototype's toggle).

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderGit2, PanelsTopLeft, Settings } from "lucide-react";
import { cn } from "cn";

const LINKS = [
  { href: "/", label: "Repos", icon: FolderGit2 },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  // "/" owns the repo list *and* every repo detail route under /repo/*, so
  // it stays lit while you're inside a repo; every other link matches by
  // prefix.
  if (href === "/") return pathname === "/" || pathname.startsWith("/repo");
  return pathname === href || pathname.startsWith(`${href}/`);
}

const PANELS_LAYOUT_KEY = "graphreview.layout.panels";

/**
 * Layout prototype (2026-10-14): "panels" floats each region of the Graph
 * tab as its own panel on a darker gutter (globals.css, `[data-layout]` on
 * <html>). Per browser, off by default.
 */
function PanelsToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(PANELS_LAYOUT_KEY) === "1";
    } catch {}
    setOn(stored);
  }, []);
  useEffect(() => {
    if (on) document.documentElement.dataset.layout = "panels";
    else delete document.documentElement.dataset.layout;
  }, [on]);
  const toggle = () => {
    const next = !on;
    try {
      localStorage.setItem(PANELS_LAYOUT_KEY, next ? "1" : "0");
    } catch {}
    setOn(next);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      title="Layout prototype: the Graph tab as separate panels on a gutter"
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
        on ? "bg-brand-muted text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      )}
    >
      <PanelsTopLeft className={cn("size-3.5", on ? "text-brand" : "text-muted-foreground/70")} aria-hidden />
      Panels
    </button>
  );
}

export function MainNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <Icon
              className={cn(
                "size-3.5",
                active ? "text-brand" : "text-muted-foreground/70"
              )}
              aria-hidden
            />
            {link.label}
          </Link>
        );
      })}
      {pathname.startsWith("/repo") && <PanelsToggle />}
    </nav>
  );
}
