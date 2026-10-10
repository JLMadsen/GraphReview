/**
 * Checks for the infra catalog (lib/analysis/infra/) and the infra
 * comparison: one fixture per tool — a Terraform root with a local and a
 * registry module, tfvars environments and a `moved` block; a Nomad job
 * with Traefik tags and a Vault template; a Kustomize base and overlay; a
 * Helm chart; a multi-stage Dockerfile — linked against a small app, then
 * a head that produces each finding.
 *
 *   npx tsx lib/analysis/infra/smoke-test-infra.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHcl } from "../syntax/hcl.mjs";
import { analyzeRepo } from "../graph-builder";
import { scanCodeFacts } from "./code-facts";
import { compareInfra } from "./compare";
import { describeInfraChange, infraChangesTouching } from "./describe";
import { readDockerfile } from "./read";
import { renderRelatedSections } from "../../ai/prompts";
import type { InfraCatalog, InfraResource } from "./types";

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

const BASE: Record<string, string> = {
  // --- Terraform: a root with a local and a registry module, tfvars environments, a moved block ---
  "infra/prod/main.tf": lines(
    "terraform {",
    "  required_providers {",
    '    aws = { source = "hashicorp/aws", version = "~> 5.0" }',
    "  }",
    '  backend "s3" { bucket = "acme-tfstate" }',
    "}",
    'provider "aws" { region = var.region }',
    'module "db" {',
    '  source         = "../modules/db"',
    "  instance_class = var.db_size",
    "}",
    'module "vpc" {',
    '  source  = "terraform-aws-modules/vpc/aws"',
    '  version = "5.1.0"',
    '  cidr    = "10.0.0.0/16"',
    "}",
    'resource "aws_s3_bucket" "assets" {',
    "  count  = var.enabled ? 1 : 0",
    '  bucket = "acme-assets"',
    "  tags   = { Name = local.name }",
    "}",
    'resource "aws_s3_bucket" "old_logs" {',
    '  bucket = "acme-logs"',
    "}",
    'resource "aws_dynamodb_table" "sessions" {',
    '  name     = "sessions"',
    '  hash_key = "id"',
    "}",
    'resource "aws_security_group" "web" {',
    "  vpc_id = module.vpc.vpc_id",
    "  depends_on = [module.db]",
    "}",
    'locals { name = "acme-${var.region}" }',
    'output "db_endpoint" { value = module.db.endpoint }',
  ),
  "infra/prod/variables.tf": lines(
    'variable "region" { default = "eu-west-1" }',
    'variable "db_size" {',
    "  type    = string",
    '  default = "db.t3.micro"',
    "}",
    'variable "enabled" { default = true }',
  ),
  "infra/prod/prod.tfvars": lines('db_size = "db.r5.large"'),
  "infra/prod/envs/staging.tfvars": lines('db_size = "db.t3.small"', 'region = "eu-central-1"'),
  "infra/prod/.terraform.lock.hcl": lines(
    'provider "registry.terraform.io/hashicorp/aws" {',
    '  version     = "5.31.0"',
    '  constraints = "~> 5.0"',
    "}",
  ),
  "infra/modules/db/main.tf": lines(
    'variable "instance_class" {}',
    'resource "aws_db_instance" "main" {',
    "  instance_class = var.instance_class",
    '  engine         = "postgres"',
    "  lifecycle {",
    "    prevent_destroy = true",
    "  }",
    "}",
    'output "endpoint" { value = aws_db_instance.main.endpoint }',
  ),

  // --- Nomad: Traefik tags, a Vault template ---
  "jobs/api.nomad": lines(
    'job "api" {',
    '  datacenters = ["dc1"]',
    '  type        = "service"',
    '  group "web" {',
    "    count = 2",
    "    network {",
    '      port "http" { to = 3000 }',
    "    }",
    "    service {",
    '      name = "api"',
    '      port = "http"',
    "      tags = [",
    '        "traefik.enable=true",',
    '        "traefik.http.routers.api.rule=Host(`api.example.com`) && PathPrefix(`/api`)",',
    '        "traefik.http.routers.api.middlewares=auth@file",',
    "      ]",
    "    }",
    '    task "server" {',
    '      driver = "docker"',
    "      config {",
    '        image = "ghcr.io/acme/api:1.4.0"',
    '        ports = ["http"]',
    "      }",
    "      env {",
    '        PORT      = "3000"',
    '        LOG_LEVEL = "info"',
    '        API_KEY   = "dev-key"',
    "      }",
    "      template {",
    "        data        = <<EOT",
    'DATABASE_URL={{ with secret "kv/data/db" }}{{ .Data.data.url }}{{ end }}',
    "EOT",
    '        destination = "secrets/db.env"',
    "        env         = true",
    "      }",
    '      vault { policies = ["api"] }',
    "    }",
    "  }",
    "}",
  ),

  // --- The app the Nomad job deploys, and its multi-stage Dockerfile ---
  "api/package.json": '{ "name": "api", "dependencies": { "express": "^4" } }\n',
  "api/Dockerfile": lines(
    "ARG NODE_VERSION=20",
    "FROM node:${NODE_VERSION}-alpine AS build",
    "WORKDIR /app",
    "COPY package.json ./",
    "COPY src ./src",
    "RUN npm ci && npm run build",
    "",
    "FROM node:${NODE_VERSION}-alpine AS runtime",
    "ENV NODE_ENV=production \\",
    "    SERVICE_NAME=api",
    "COPY --from=build /app/dist ./dist",
    "EXPOSE 3000",
    "USER node",
    'CMD ["node", "dist/server.js"]',
  ),
  "api/src/server.ts": lines(
    'import express from "express";',
    "const app = express();",
    'app.get("/api/orders", (req, res) => res.json([]));',
    'app.post("/api/orders", (req, res) => res.json({}));',
    'app.get("/health", (req, res) => res.send("ok"));',
    "const db = process.env.DATABASE_URL;",
    "const level = process.env.LOG_LEVEL;",
    'const key = process.env["API_KEY"];',
    "app.listen(process.env.PORT ?? 3000);",
  ),
  Makefile: lines("VERSION ?= dev", "image:", "\tdocker build -t ghcr.io/acme/api:$(VERSION) -f api/Dockerfile api"),
  "api/.env.example": lines("DATABASE_URL=", "LOG_LEVEL=debug"),

  // --- Kustomize: a base and an overlay ---
  "deploy/base/kustomization.yaml": lines(
    "resources:",
    "  - deployment.yaml",
    "  - service.yaml",
    "  - db.yaml",
    "configMapGenerator:",
    "  - name: web-config",
    "    literals:",
    "      - LOG_LEVEL=info",
  ),
  "deploy/base/deployment.yaml": lines(
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    "  replicas: 2",
    "  selector:",
    "    matchLabels: { app: web }",
    "  template:",
    "    metadata:",
    "      labels: { app: web }",
    "    spec:",
    "      containers:",
    "        - name: web",
    "          image: acme/web:1.0",
    "          ports:",
    "            - containerPort: 8080",
    "          envFrom:",
    "            - configMapRef: { name: web-config }",
    "          env:",
    "            - name: DB_PASSWORD",
    "              valueFrom:",
    "                secretKeyRef: { name: db, key: password }",
  ),
  "deploy/base/service.yaml": lines(
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    "  name: web",
    "spec:",
    "  selector: { app: web }",
    "  ports:",
    "    - port: 80",
    "      targetPort: 8080",
    "---",
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: web",
    "  annotations:",
    "    nginx.ingress.kubernetes.io/auth-url: https://auth.example.com/check",
    "spec:",
    "  rules:",
    "    - host: web.example.com",
    "      http:",
    "        paths:",
    "          - path: /",
    "            pathType: Prefix",
    "            backend:",
    "              service: { name: web, port: { number: 80 } }",
  ),
  "deploy/base/db.yaml": lines(
    "apiVersion: apps/v1",
    "kind: StatefulSet",
    "metadata:",
    "  name: db",
    "spec:",
    "  serviceName: db",
    "  selector: { matchLabels: { app: db } }",
    "  template:",
    "    metadata: { labels: { app: db } }",
    "    spec:",
    "      containers:",
    "        - name: postgres",
    "          image: postgres:16",
  ),
  "deploy/overlays/prod/kustomization.yaml": lines(
    "resources:",
    "  - ../../base",
    "namePrefix: prod-",
    "images:",
    "  - name: acme/web",
    '    newTag: "2.0"',
    "replicas:",
    "  - name: web",
    "    count: 5",
    "patches:",
    "  - path: resources.yaml",
    "  - target: { kind: Service, name: web }",
    "    patch: |-",
    "      - op: replace",
    "        path: /spec/type",
    "        value: LoadBalancer",
  ),
  "deploy/overlays/prod/resources.yaml": lines(
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: web",
    "          resources:",
    "            limits: { memory: 512Mi }",
  ),

  // --- Helm ---
  "charts/web/Chart.yaml": lines(
    "apiVersion: v2",
    "name: web",
    "version: 0.1.0",
    "appVersion: 1.2.3",
    "dependencies:",
    "  - name: postgresql",
    "    version: 12.1.0",
    "    repository: https://charts.bitnami.com/bitnami",
    "    condition: postgresql.enabled",
  ),
  "charts/web/values.yaml": lines("replicaCount: 2", "image:", "  repository: acme/web", '  tag: ""', "service:", "  port: 80"),
  "charts/web/values-prod.yaml": lines("replicaCount: 4"),
  "charts/web/templates/deployment.yaml": lines(
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    '  name: {{ include "web.fullname" . }}',
    "spec:",
    "  replicas: {{ .Values.replicaCount }}",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: web",
    '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"',
  ),
  "charts/web/templates/service.yaml": lines(
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    "  name: web",
    "spec:",
    "  ports:",
    "    - port: {{ .Values.service.port }}",
  ),
  "charts/web/templates/_helpers.tpl": '{{- define "web.fullname" -}}{{ .Release.Name }}{{- end }}\n',
};

/** The head: each finding, a moved block, version changes, an update. */
function headTree(): Record<string, string> {
  const head = { ...BASE };
  head["infra/prod/main.tf"] = BASE["infra/prod/main.tf"]
    // renamed without a moved block (stateful bucket)
    .replace('resource "aws_s3_bucket" "assets" {', 'resource "aws_s3_bucket" "static_assets" {')
    // renamed with a moved block
    .replace('resource "aws_s3_bucket" "old_logs" {', 'resource "aws_s3_bucket" "logs" {')
    // a stateful table destroyed
    .replace(/resource "aws_dynamodb_table" "sessions" \{[\s\S]*?\n\}\n/, "")
    // a registry module's version bumped
    .replace('version = "5.1.0"', 'version = "5.2.0"')
    .concat(lines("moved {", "  from = aws_s3_bucket.old_logs", "  to   = aws_s3_bucket.logs", "}"));
  // prevent_destroy lifted from the database
  head["infra/modules/db/main.tf"] = BASE["infra/modules/db/main.tf"].replace("    prevent_destroy = true\n", "");
  // the workload no longer sets an env var its code reads
  head["jobs/api.nomad"] = BASE["jobs/api.nomad"].replace('        API_KEY   = "dev-key"\n', "");
  // base image bumped
  head["api/Dockerfile"] = BASE["api/Dockerfile"].replace("ARG NODE_VERSION=20", "ARG NODE_VERSION=22");
  // a plain update
  head["deploy/base/deployment.yaml"] = BASE["deploy/base/deployment.yaml"].replace("replicas: 2", "replicas: 3");
  return head;
}

const byAddress = (c: InfraCatalog, address: string, stack?: string): InfraResource | undefined =>
  c.resources.find((r) => r.address === address && (!stack || r.stack === stack));

async function main(): Promise<void> {
  console.log("HCL reader");
  {
    const file = readHcl(lines('a = "x" # c', 'b "l1" "l2" { c = [var.x, aws_y.z.id] }', 'd = <<EOF', "${local.q}", "EOF", "e { f = 1 }"));
    check("attributes and labelled blocks", file.body.attrs.length === 2 && file.body.blocks.length === 2 && file.body.blocks[0].labels.join(",") === "l1,l2", JSON.stringify(file.body));
    check("traversals in lists and heredocs", file.body.blocks[0].body.attrs[0].expr.refs.includes("var.x") && file.body.blocks[0].body.attrs[0].expr.refs.includes("aws_y.z.id") && file.body.attrs[1].expr.refs.includes("local.q"));
    check("a trailing comment isn't part of the value", file.body.attrs[0].expr.text === '"x"', file.body.attrs[0].expr.text);
    const levant = readHcl(lines('job "[[ .name ]]" {', "  [[ if .x ]]", '  datacenters = [[ .dcs | toJson ]]', "  [[ end ]]", "}"));
    check("Levant templating is kept and marked", levant.templated === true && levant.body.blocks[0]?.body.attrs[0]?.name === "datacenters", JSON.stringify(levant));
  }

  console.log("Dockerfile reader");
  {
    const stages = readDockerfile(BASE["api/Dockerfile"]);
    check("two named stages, ARG defaults substituted", stages.length === 2 && stages[0].name === "build" && stages[0].from.image === "node" && stages[0].from.tag === "20-alpine", JSON.stringify(stages.map((s) => s.from)));
    check("ENV across a continuation, EXPOSE, USER, CMD", stages[1].env.length === 2 && stages[1].expose[0] === "3000" && stages[1].user === "node" && stages[1].cmd === "node dist/server.js");
    check("COPY sources and --from", stages[0].copies.map((c) => c.sources.join(",")).join("|") === "package.json|src" && stages[1].copies[0].from === "build");
  }

  console.log("code facts");
  {
    const ts = scanCodeFacts("typescript", BASE["api/src/server.ts"]);
    check("TS env reads and listen port", ts?.env?.map(([n]) => n).join(",") === "DATABASE_URL,LOG_LEVEL,API_KEY,PORT" && ts.ports?.[0]?.[0] === 3000, JSON.stringify(ts));
    const py = scanCodeFacts("python", 'import os\nDB = os.environ["DB_URL"]\nX = os.getenv("X_FLAG")\nuvicorn.run(app, host="0.0.0.0", port=8000)\n');
    check("Python env reads and port", py?.env?.map(([n]) => n).join(",") === "DB_URL,X_FLAG" && py.ports?.[0]?.[0] === 8000, JSON.stringify(py));
    const go = scanCodeFacts("go", 'v := os.Getenv("GO_VAR")\nhttp.ListenAndServe(":8081", nil)\n');
    check("Go env read and port", go?.env?.[0]?.[0] === "GO_VAR" && go.ports?.[0]?.[0] === 8081, JSON.stringify(go));
    const java = scanCodeFacts("java", 'String u = System.getenv("JAVA_VAR");\n@Value("${SPRING_VAR:x}") String s;\n');
    check("Java env reads", java?.env?.map(([n]) => n).join(",") === "JAVA_VAR,SPRING_VAR", JSON.stringify(java));
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "graphreview-infra-"));
  const headDir = mkdtempSync(path.join(os.tmpdir(), "graphreview-infra-head-"));
  try {
    writeTree(tmp, BASE);
    const base = await analyzeRepo(tmp);
    const infra = base.infra;
    console.log(`catalog: ${infra.stacks.length} stacks, ${infra.resources.length} resources`);

    console.log("Terraform");
    const tf = "terraform:infra/prod";
    check("one stack; the called module folder isn't one", infra.stacks.some((s) => s.id === tf) && !infra.stacks.some((s) => s.id === "terraform:infra/modules/db"), infra.stacks.map((s) => s.id).join(", "));
    const stack = infra.stacks.find((s) => s.id === tf);
    check("tfvars files are environments", stack?.environments.join(",") === "prod,staging", stack?.environments.join(","));
    check("backend", stack?.backend === "s3");
    const db = byAddress(infra, "module.db.aws_db_instance.main", tf);
    check("local module followed: address, stateful, prevent_destroy", Boolean(db?.stateful && db.lifecycle?.preventDestroy && db.group === "module.db"), JSON.stringify(db));
    const vpc = byAddress(infra, "module.vpc", tf);
    check("registry module is external with its version", vpc?.external === true && vpc.version === "5.1.0", JSON.stringify(vpc));
    check("provider version from the lock file", byAddress(infra, "provider.aws", tf)?.version === "5.31.0", JSON.stringify(byAddress(infra, "provider.aws", tf)));
    const assets = byAddress(infra, "aws_s3_bucket.assets", tf);
    check("count with a conditional: ×? and conditional", assets?.count === "?" && assets.conditional === true, JSON.stringify(assets));
    const dbSize = byAddress(infra, "var.db_size", tf);
    check("variable values per environment", dbSize?.envValues?.prod?.[0]?.value === '"db.r5.large"' && dbSize.envValues?.staging?.[0]?.value === '"db.t3.small"', JSON.stringify(dbSize?.envValues));
    check("module input that is a variable: values per environment", byAddress(infra, "module.db", tf)?.envValues?.prod?.some((a) => a.name === "instance_class") === true);
    const sg = byAddress(infra, "aws_security_group.web", tf);
    check("references and depends_on", Boolean(sg?.refs.includes(`${tf}:module.vpc`) && sg.refs.includes(`${tf}:module.db`)), JSON.stringify(sg?.refs));
    check("locals and outputs", Boolean(byAddress(infra, "local.name", tf) && byAddress(infra, "output.db_endpoint", tf)?.refs.includes(`${tf}:module.db`)));

    console.log("Nomad");
    const task = infra.resources.find((r) => r.id === "nomad:jobs/api.nomad:api/web/server");
    check("job → group → task", Boolean(task && infra.resources.some((r) => r.id === "nomad:jobs/api.nomad:api/web") && infra.resources.some((r) => r.id === "nomad:jobs/api.nomad:api")));
    check("group count", infra.resources.find((r) => r.id === "nomad:jobs/api.nomad:api/web")?.count === "2");
    check("task env, template env keys, Vault path", Boolean(task?.workload?.env.PORT && task.workload.env.DATABASE_URL?.startsWith("template") && task.workload.secrets?.some((s) => s.includes("kv/data/db"))), JSON.stringify(task?.workload));
    check("Traefik route with auth middleware", task?.workload?.routes[0]?.path === "/api" && task.workload.routes[0].host === "api.example.com" && Boolean(task.workload.routes[0].auth?.length), JSON.stringify(task?.workload?.routes));
    check("port mapping", task?.workload?.ports.some((p) => p.to === 3000) === true);

    console.log("Docker");
    check("Dockerfile stack with its stages", Boolean(byAddress(infra, "build", "docker:api/Dockerfile") && byAddress(infra, "runtime", "docker:api/Dockerfile")));
    const baseImage = infra.resources.find((r) => r.stack === "docker:api/Dockerfile" && r.category === "image");
    check("base image is external with its tag", baseImage?.external === true && baseImage.version === "20-alpine", JSON.stringify(baseImage));

    console.log("Kubernetes / Kustomize");
    const kStack = infra.stacks.find((s) => s.id === "k8s:deploy/base");
    check("base is the stack, overlay is its environment", kStack?.environments.join(",") === "prod", JSON.stringify(kStack));
    const web = byAddress(infra, "Deployment/web", "k8s:deploy/base");
    check("overlay images, replicas, prefix and a known-field patch become values per environment", Boolean(
      web?.envValues?.prod?.some((a) => a.name === "image" && a.value === "acme/web:2.0") &&
        web.envValues.prod.some((a) => a.name === "spec.replicas" && a.value === "5") &&
        web.envValues.prod.some((a) => a.name === "metadata.name" && a.value === "prod-web") &&
        web.envValues.prod.some((a) => a.name.includes("resources.limits.memory"))
    ), JSON.stringify(web?.envValues));
    check("a JSON patch marks its target patched", byAddress(infra, "Service/web", "k8s:deploy/base")?.patched === true);
    check("envFrom a known (generated) ConfigMap sets its keys; secretKeyRef sets by name", web?.workload?.env.LOG_LEVEL === "configmap web-config" && web.workload.env.DB_PASSWORD?.startsWith("secret") === true, JSON.stringify(web?.workload?.env));
    check("StatefulSet is stateful", byAddress(infra, "StatefulSet/db", "k8s:deploy/base")?.stateful === true);
    check("Ingress → Service → Deployment route with auth", web?.workload?.routes.some((r) => r.host === "web.example.com" && r.auth?.length) === true, JSON.stringify(web?.workload?.routes));

    console.log("Helm");
    const chart = infra.stacks.find((s) => s.id === "helm:charts/web");
    check("chart stack with values files as environments", chart?.environments.join(",") === "prod" && chart.version === "0.1.0", JSON.stringify(chart));
    const dep = infra.resources.find((r) => r.stack === "helm:charts/web" && r.category === "chart");
    check("dependency is external with its version", dep?.external === true && dep.version === "12.1.0" && dep.conditional === true, JSON.stringify(dep));
    const tpl = infra.resources.find((r) => r.stack === "helm:charts/web" && r.kind === "Deployment");
    check("templated resource, image from values + appVersion, values per environment", Boolean(tpl?.templated && tpl.workload?.images[0] === "acme/web:1.2.3" && tpl.envValues?.prod?.some((a) => a.name === ".Values.replicaCount")), JSON.stringify(tpl));

    console.log("links");
    const deploy = infra.links.deploys.find((d) => d.resource === task?.id);
    check("image → Dockerfile via CI build, with the folders it copies", deploy?.resolved === true && deploy.dockerfile === "api/Dockerfile" && deploy.folders.join(",") === "api/package.json,api/src", JSON.stringify(deploy));
    check("third-party image stays unresolved, saying why", infra.links.deploys.some((d) => d.image === "postgres:16" && !d.resolved && d.via.length > 0));
    const env = infra.links.env.find((l) => l.resource === task?.id);
    check("env: nothing read but not set at the base", env?.readNotSet.length === 0, JSON.stringify(env));
    const route = infra.links.routes.find((r) => r.resource === task?.id);
    check("route /api → the endpoints under it", route?.endpoints.length === 2 && route.endpoints.every((e) => e.includes("/api/orders")), JSON.stringify(route));
    const port = infra.links.ports.find((p) => p.resource === task?.id);
    check("ports match", port?.match === true && port.listen === 3000, JSON.stringify(port));

    console.log("graph files");
    const langs = new Map(base.files.map((f) => [f.file, f.language]));
    check("infra files join the graph with their tool as language", langs.get("infra/prod/main.tf") === "terraform" && langs.get("jobs/api.nomad") === "nomad" && langs.get("api/Dockerfile") === "dockerfile" && langs.get("deploy/base/deployment.yaml") === "kubernetes" && langs.get("charts/web/Chart.yaml") === "helm");
    check("…and form modules of their folder", base.modules.some((m) => m.filePaths.includes("jobs/api.nomad")));
    check("scripts and env files are read, not graph files", !langs.has("Makefile") && !langs.has("api/.env.example"));

    console.log("comparison");
    writeTree(headDir, headTree());
    const head = await analyzeRepo(headDir);
    const diff = compareInfra(base.infra, head.infra);
    const entry = (action: string, address: string) => diff.changes.find((c) => c.action === action && c.resource.address === address);
    const rules = diff.findings.map((f) => f.rule);
    check("rename without moved → finding", rules.includes("rename-without-moved") && diff.findings.some((f) => f.summary.includes("aws_s3_bucket.static_assets")), JSON.stringify(diff.findings.map((f) => f.summary)));
    check("…and not also 'stateful destroyed' for the renamed bucket", !diff.findings.some((f) => f.rule === "stateful-destroyed" && f.summary.includes("assets")));
    check("stateful resource destroyed → finding", diff.findings.some((f) => f.rule === "stateful-destroyed" && f.summary.includes("aws_dynamodb_table.sessions")));
    check("prevent_destroy removed → finding", diff.findings.some((f) => f.rule === "prevent-destroy-removed" && f.resource.endsWith("module.db.aws_db_instance.main")));
    check("env var no longer set → finding on the workload", diff.findings.some((f) => f.rule === "env-unset" && f.summary.includes("API_KEY") && f.file === "jobs/api.nomad"), JSON.stringify(diff.findings));
    check("exactly those four findings", diff.findings.length === 4, rules.join(", "));
    check("moved block → moved entry", entry("moved", "aws_s3_bucket.logs")?.movedFrom === "aws_s3_bucket.old_logs");
    check("registry module version → version entry", entry("version", "module.vpc")?.version?.after === "5.2.0");
    check("FROM tag → version entries for the stages", entry("version", "build")?.version?.before === "20-alpine" && entry("version", "runtime")?.version?.after === "22-alpine", JSON.stringify(diff.changes.filter((c) => c.resource.tool === "docker").map((c) => `${c.action} ${c.resource.address}`)));
    check("an update with its attribute delta", entry("update", "Deployment/web")?.deltas.some((d) => d.name === "spec.replicas" && d.before === "2" && d.after === "3") === true);
    const rank = { destroy: 0, moved: 1, update: 2, version: 3, create: 4 } as const;
    const plain = diff.changes.filter((c) => !c.findings);
    check(
      "findings first, then destroy → moved → update → version → create",
      diff.changes.findIndex((c) => !c.findings) === diff.changes.length - plain.length && plain.every((c, i) => i === 0 || rank[plain[i - 1].action] <= rank[c.action]),
      diff.changes.map((c) => `${c.action} ${c.resource.address} ${c.findings?.length ?? 0}`).join(", ")
    );
    check("link delta: env var no longer set", diff.links.some((l) => l.kind === "env" && l.text.includes("API_KEY")));
    const ctx = infraChangesTouching(diff, head.infra, new Set(["api/src/server.ts"]));
    check("a deployed component's review sees its workload's change and finding", ctx.entries.some((e) => e.resource.address === "api/web/server") && ctx.findings.some((f) => f.rule === "env-unset"), JSON.stringify(ctx));
    check("described for prompts", describeInfraChange(diff).length > 5);
    const prompt = renderRelatedSections({ infra: ctx.entries.map((e) => e.id), alreadyReported: ctx.findings.map((f) => f.summary) });
    check("the review prompt gets the infra section and the already-reported findings", prompt.includes("## Infrastructure this change affects") && prompt.includes("do not repeat") && prompt.includes("API_KEY"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall infra checks passed");
}

void main();
