import Link from "next/link";
import { BotOff } from "lucide-react";
import { cn } from "cn";

/**
 * "AI off" (DESIGN.md §6.25): no AI provider is active, so reviews, labels,
 * the chat and the AI checklist items don't run. A link to Settings → AI
 * providers. Shown on repo cards and in the top bar.
 */
export function AiOffChip({ className }: { className?: string }) {
  return (
    <Link
      href="/settings#ai-providers"
      title="No AI provider is configured — reviews, labels and the chat are off. Set one up in Settings."
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-warning/30 transition-colors hover:bg-warning/20",
        className
      )}
    >
      <BotOff className="size-3" aria-hidden />
      AI off
    </Link>
  );
}
