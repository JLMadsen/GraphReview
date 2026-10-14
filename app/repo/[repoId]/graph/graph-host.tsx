"use client";

// Hosts GraphView so the command palette can switch its review target
// (DESIGN.md §6.18): a retarget newer than this mount starts GraphView over
// on the palette's target; otherwise it opens on the page's URL params.

import { useState } from "react";
import { GraphView } from "@/components/graph";
import { useGraphRetarget } from "@/components/palette/bus";

export function GraphHost(props: { repoId: string; initialPrNumber?: number; initialBaseRef?: string; initialHeadRef?: string }) {
  const { generation, target } = useGraphRetarget();
  const [mountedAt] = useState(generation);
  if (generation === mountedAt) return <GraphView {...props} />;
  return (
    <GraphView
      key={generation}
      repoId={props.repoId}
      initialPrNumber={target && "pr" in target ? target.pr : undefined}
      initialBaseRef={target && "base" in target ? target.base : undefined}
      initialHeadRef={target && "head" in target ? target.head : undefined}
    />
  );
}
