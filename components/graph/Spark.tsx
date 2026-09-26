// The one mark for "enriched by the model": a small, muted ✦. It goes on
// things the model wrote or judged (a described card, a judged checklist
// item, a review-named group) and on the buttons that produce them — and on
// nothing else, so it keeps meaning exactly that. Labels name the result
// ("Describe modules"), the ✦ says where it came from.

import { cn } from "cn";

export function Spark({ className, title = "Written by the model" }: { className?: string; title?: string }) {
  return (
    <span className={cn("inline-block text-[10px] leading-none text-brand/75 select-none", className)} title={title} aria-label={title}>
      ✦
    </span>
  );
}
