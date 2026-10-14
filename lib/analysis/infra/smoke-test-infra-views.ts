/**
 * Checks for the Infra view's Diagram, Files and Requests (DESIGN.md §6.16):
 * a small Kubernetes app — an Ingress to a frontend that calls a cart
 * service through an env var, the cart keeping data in Redis with a disk —
 * analysed, compared with a head that stops setting REDIS_ADDR, then
 * reshaped by `buildInfraTopology`, `buildJourney`, `explainResource` and
 * `mergeWithPatch`.
 *
 *   npx tsx lib/analysis/infra/smoke-test-infra-views.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRepo } from "../graph-builder";
import { compareInfra } from "./compare";
import { buildInfraRows } from "../../../components/graph/infra-view-model";
import { buildInfraTopology, buildJourney, entryId, envHost, touchedNeighbourhood } from "../../../components/graph/infra-topology";
import { explainResource, explainTitle } from "../../../components/graph/infra-explain";
import { mergeWithPatch } from "../../../components/graph/diff-utils";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

function deployment(name: string, port: number, env: Record<string, string>, extra: string[] = []): string {
  return lines(
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  replicas: 2",
    "  selector:",
    "    matchLabels:",
    `      app: ${name}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${name}`,
    "    spec:",
    "      containers:",
    `        - name: ${name}`,
    `          image: ${name}`,
    "          ports:",
    `            - containerPort: ${port}`,
    ...(Object.keys(env).length ? ["          env:", ...Object.entries(env).flatMap(([k, v]) => [`            - name: ${k}`, `              value: "${v}"`])] : []),
    ...extra,
    "---",
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  selector:",
    `    app: ${name}`,
    "  ports:",
    `    - port: ${port}`,
    `      targetPort: ${port}`
  );
}

function tree(withRedisAddr: boolean): Record<string, string> {
  return {
    // The head opens cart to the outside with a NodePort Service.
    ...(withRedisAddr ? {} : { "k8s/cart-debug.yaml": lines("apiVersion: v1", "kind: Service", "metadata:", "  name: cart-debug", "spec:", "  type: NodePort", "  selector:", "    app: cart", "  ports:", "    - port: 7070") }),
    "frontend/Dockerfile": lines("FROM golang:1.22 AS build", "COPY . /src", "FROM alpine:3.20", "COPY --from=build /src/app /app", "EXPOSE 8080"),
    "frontend/main.go": lines("package main", 'import ("net/http"; "os")', "func main() {", '  _ = os.Getenv("CART_ADDR")', '  http.ListenAndServe(":8080", nil)', "}"),
    "cart/Dockerfile": lines("FROM golang:1.22", "COPY . /src", "EXPOSE 7070"),
    "cart/main.go": lines("package main", 'import ("net/http"; "os")', "func main() {", '  _ = os.Getenv("REDIS_ADDR")', '  http.ListenAndServe(":7070", nil)', "}"),
    "k8s/frontend.yaml": deployment("frontend", 8080, { CART_ADDR: "cart:7070" }),
    "k8s/cart.yaml": deployment("cart", 7070, withRedisAddr ? { REDIS_ADDR: "redis:6379" } : {}),
    "k8s/redis.yaml": lines(
      "apiVersion: apps/v1",
      "kind: StatefulSet",
      "metadata:",
      "  name: redis",
      "spec:",
      "  selector:",
      "    matchLabels:",
      "      app: redis",
      "  template:",
      "    metadata:",
      "      labels:",
      "        app: redis",
      "    spec:",
      "      containers:",
      "        - name: redis",
      "          image: redis:7",
      "      volumes:",
      "        - name: data",
      "          persistentVolumeClaim:",
      "            claimName: redis-data",
      "---",
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      "  name: redis-data",
      "spec:",
      "  resources:",
      "    requests:",
      "      storage: 1Gi",
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: redis",
      "spec:",
      "  selector:",
      "    app: redis",
      "  ports:",
      "    - port: 6379"
    ),
    "k8s/ingress.yaml": lines(
      "apiVersion: networking.k8s.io/v1",
      "kind: Ingress",
      "metadata:",
      "  name: web",
      "spec:",
      "  rules:",
      "    - host: shop.example.com",
      "      http:",
      "        paths:",
      "          - path: /",
      "            pathType: Prefix",
      "            backend:",
      "              service:",
      "                name: frontend",
      "                port:",
      "                  number: 8080"
    ),
  };
}

async function main() {
  console.log("env values → host names");
  check("host:port", envHost("cart:7070") === "cart");
  check("url with a path", envHost("http://cart.default.svc.cluster.local:7070/x") === "cart");
  check("not a host", envHost("some text with spaces") === undefined);

  console.log("merging a diff into the head");
  const merged = mergeWithPatch("a\nB\nc\nd\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  check(
    "removed lines sit before the line that replaced them, unchanged lines keep both numbers",
    merged.map((l) => `${l.type}:${l.old ?? "-"}/${l.neu ?? "-"}:${l.text}`).join(" ") === "ctx:1/1:a del:2/-:b add:-/2:B ctx:3/3:c ctx:4/4:d",
    JSON.stringify(merged)
  );

  const base = mkdtempSync(path.join(os.tmpdir(), "graphreview-infra-views-"));
  const headDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-infra-views-head-"));
  try {
    writeTree(base, tree(true));
    writeTree(headDir, tree(false));
    const a = await analyzeRepo(base);
    const b = await analyzeRepo(headDir);
    const catalog = a.infra;
    const change = compareInfra(a.infra, b.infra);
    const rows = buildInfraRows(catalog, change);
    const topo = buildInfraTopology(catalog, rows);
    const id = (label: string) => topo.workloads.find((w) => w.label === label)?.id ?? topo.data.find((d) => d.label === label)?.id ?? "?";

    console.log("diagram");
    check("three programs", topo.workloads.map((w) => w.label).join(",") === "cart,frontend,redis", topo.workloads.map((w) => w.label).join(","));
    check("the disk holds data", topo.data.some((d) => d.label === "redis-data"), topo.data.map((d) => d.label).join(","));
    const shop = topo.entries.find((e) => e.host === "shop.example.com");
    check("a way in to the frontend", shop?.routes[0]?.workload === id("frontend") && !shop.state, JSON.stringify(topo.entries));
    const debug = topo.entries.find((e) => e.host === "NodePort cart-debug");
    check("the diff's new NodePort Service is a way in, marked added", debug?.state === "create" && debug.routes[0]?.workload === id("cart"), JSON.stringify(topo.entries));
    const edge = (from: string, to: string) => topo.edges.find((e) => e.from === id(from) && e.to === id(to));
    check("frontend calls cart through its env var", edge("frontend", "cart")?.via === "env CART_ADDR", JSON.stringify(topo.edges));
    check("cart called redis — the diff removes the link", edge("cart", "redis")?.gone === true, JSON.stringify(edge("cart", "redis")));
    check("redis keeps data on its disk", edge("redis", "redis-data")?.kind === "uses");
    check("cart's env-unset finding marks its node", (topo.workloads.find((w) => w.label === "cart")?.findings ?? 0) > 0, JSON.stringify(change.findings.map((f) => f.summary)));
    const near = touchedNeighbourhood(topo);
    check("only-changes keeps cart and its neighbours", near.has(id("cart")) && near.has(id("frontend")) && near.has(id("redis")), [...near].join(","));
    check("…and the new way in", near.has(entryId("NodePort cart-debug")), [...near].join(","));

    console.log("requests");
    const route = shop!.routes[0];
    const hops = buildJourney(topo, catalog, rows, route);
    const kinds = hops.map((h) => h.kind).join(",");
    check("route → program → build → env → calls", kinds.startsWith("route,workload,build") && kinds.includes("calls"), kinds);
    check("the port matches the code", hops.find((h) => h.kind === "workload")?.detail?.includes("listens on 8080") === true, JSON.stringify(hops.find((h) => h.kind === "workload")));
    check("the call to cart is flagged by cart's finding", hops.find((h) => h.kind === "calls")?.children?.[0]?.tone === "bad", JSON.stringify(hops.find((h) => h.kind === "calls")));

    console.log("files");
    const cartRow = rows.find((r) => r.resource.id === id("cart"))!;
    const note = explainResource(cartRow, catalog);
    check("a Deployment in words", note.title.startsWith("Keeps a program running"), note.title);
    check("its code link", note.lines.some((l) => l.text.includes("cart/Dockerfile")), JSON.stringify(note.lines));
    check("the diff's finding in the note", note.change.some((l) => l.tone === "bad" && l.text.includes("REDIS_ADDR")), JSON.stringify(note.change));
    check("a Terraform type in words", explainTitle({ ...cartRow.resource, tool: "terraform", category: "resource", kind: "google_redis_instance", count: undefined }).startsWith("Creates a managed Redis cache"));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall infra view checks passed");
}

void main();
