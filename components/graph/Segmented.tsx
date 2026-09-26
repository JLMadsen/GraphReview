"use client";

// The Graph tab's one segmented control: a flat, square-cornered row of
// buttons sharing hairline borders. Used for every "pick one of a few" switch
// (view, level of detail, diff source) so they read as one family instead of
// four stacked pill toggles.

import { cn } from "cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "sm",
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex w-fit items-stretch", className)}>
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            title={opt.title}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 border border-border font-medium whitespace-nowrap transition-colors",
              size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
              i > 0 && "-ml-px",
              i === 0 && "rounded-l-md",
              i === options.length - 1 && "rounded-r-md",
              active
                ? "relative z-10 border-foreground/25 bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
