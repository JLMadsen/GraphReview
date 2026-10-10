/**
 * The infra catalog: what infrastructure a commit declares, read statically
 * from its Terraform / OpenTofu, Nomad, Kubernetes (manifests, Kustomize),
 * Helm and Dockerfiles, and how it links to the app's own code
 * (DESIGN.md §6.12). Pure data — built by ./catalog.ts, compared by
 * ./compare.ts, stored as JSON and sent to the browser as is.
 *
 * Nothing is evaluated: no `terraform plan`, no providers, no state, no
 * `helm template`. Expressions are kept as written.
 */

export type InfraTool = "terraform" | "nomad" | "kubernetes" | "helm" | "docker";

/** What sort of thing a row is — drives grouping, ordering and what a change means. */
export type InfraCategory =
  | "resource" // a managed Terraform resource
  | "data" // a Terraform data source
  | "module" // a Terraform module call (local, or external: registry/git)
  | "variable"
  | "output"
  | "local"
  | "provider"
  | "job" // Nomad job
  | "group" // Nomad task group
  | "task" // Nomad task
  | "workload" // Kubernetes Deployment / StatefulSet / DaemonSet / Job / CronJob / Pod
  | "service"
  | "route" // Ingress, HTTPRoute
  | "config" // ConfigMap
  | "secret" // Secret (key names only)
  | "volume" // PVC, PV, Nomad volume
  | "autoscaler"
  | "stage" // a Dockerfile build stage
  | "image" // an external base image
  | "chart" // a Helm chart dependency
  | "other";

/** One attribute, its value as written (whitespace collapsed, capped). Nested blocks are dotted: `network.port.http.static`. */
export interface InfraAttr {
  name: string;
  value: string;
}

/** Where a workload's code links come from: what it runs and what it is given. */
export interface InfraWorkload {
  /** Container / task images, as written (`ghcr.io/acme/api:1.4`, `{{ .Values.image.repository }}`). */
  images: string[];
  /** Env vars set by name → where the value comes from (`"3000"`, `secret db/url`, `configmap app/LOG_LEVEL`, `template`). */
  env: Record<string, string>;
  /**
   * Sources that may set any name, so a missing one is never reported:
   * `envFrom` a Secret or an unknown ConfigMap, a template whose keys aren't literal, a templated chart.
   */
  maybeEnv: string[];
  /** Ports it declares: container ports, Nomad `port` blocks (static, `to`). */
  ports: Array<{ name?: string; port?: number; to?: number }>;
  /** Routes pointing at it: Traefik tags, Ingress / HTTPRoute rules. */
  routes: Array<{ host?: string; path: string; via: string; auth?: string[] }>;
  /** Nomad `artifact` sources (a repo path deploys that folder directly). */
  artifacts?: string[];
  /** Vault / Consul / Nomad-variable paths its templates read. */
  secrets?: string[];
}

export interface InfraResource {
  /** Stable across commits: `tool:stack:address` (`terraform:infra/prod:module.db.aws_db_instance.main`). */
  id: string;
  tool: InfraTool;
  /** The stack's id (see {@link InfraStack.id}). */
  stack: string;
  /** What the list groups it under inside its stack: `(root)`, `module.db`, `job api`, `chart api`. */
  group: string;
  /** `aws_db_instance`, `variable`, `Deployment`, `task`, `stage`, … */
  kind: string;
  category: InfraCategory;
  /** `module.db.aws_db_instance.main`, `api/web/server`, `Deployment/api`, `build`. */
  address: string;
  name: string;
  file: string;
  line: number;
  endLine?: number;
  /** As written; at most {@link MAX_ATTRS}. */
  attributes: InfraAttr[];
  /** Values per environment (tfvars file, Kustomize overlay, Helm values file), only where they differ from the default. */
  envValues?: Record<string, InfraAttr[]>;
  /** `count` / `for_each` / `replicas`: a literal number, or `?` when it isn't one. Shown as ×N. */
  count?: string;
  /** `count = var.x ? 1 : 0` and the like. */
  conditional?: true;
  /** Levant / nomad-pack `[[ ]]`, Helm templates: shown as written, never resolved. */
  templated?: true;
  /** Holds data: a database, bucket, disk, volume, queue, key, DNS zone (built-in list, never a guess from names). */
  stateful?: true;
  /** Not in the repo: a registry/git module, a base image, a chart dependency. */
  external?: true;
  /** Changed by a Kustomize patch that isn't applied here. */
  patched?: true;
  /** A version: a module's constraint, an image tag or digest, a provider version, a chart version. */
  version?: string;
  /** Module source, image name. */
  source?: string;
  lifecycle?: { preventDestroy?: true; createBeforeDestroy?: true; ignoreChanges?: string[] };
  /** Ids of resources it references (expressions, `depends_on`, module wiring, selectors, backends). */
  refs: string[];
  workload?: InfraWorkload;
}

export interface InfraStack {
  /** `terraform:infra/prod`, `nomad:jobs/api.nomad`, `k8s:deploy/base`, `helm:charts/api`, `docker:api/Dockerfile`. */
  id: string;
  tool: InfraTool;
  /** Folder (Terraform, Kustomize, Helm, manifests) or file (Nomad job file, Dockerfile). */
  path: string;
  name: string;
  /** `root module`, `job file`, `kustomization`, `manifests`, `chart`, `Dockerfile`. */
  kind: string;
  /** Environments: tfvars files, Kustomize overlays, Helm values files. */
  environments: string[];
  /** Terraform backend type (`s3`, `gcs`, `remote`). */
  backend?: string;
  /** Helm: chart version / appVersion. */
  version?: string;
}

/** A Terraform `moved` / `removed` / `import` block, with the stack's module prefix applied. */
export interface InfraMoveBlock {
  kind: "moved" | "removed" | "import";
  stack: string;
  /** Addresses within the stack (`module.db.aws_db_instance.main`). */
  from?: string;
  to?: string;
  /** `removed { lifecycle { destroy = false } }`: forgotten, not destroyed. */
  destroy?: boolean;
  file: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Links to code (./link.ts)
// ---------------------------------------------------------------------------

/** A workload → the image it runs → the Dockerfile that builds it → the code folders that go into it. */
export interface InfraDeployLink {
  /** The workload resource. */
  resource: string;
  image?: string;
  /** Repo path of the Dockerfile, when resolved. */
  dockerfile?: string;
  /** How the link was made, or why it wasn't (`CI builds it with docker build -t api`, `folder name`, `no Dockerfile in the repo builds it`). */
  via: string;
  resolved: boolean;
  /** Repo folders (or files) whose code ships in it: the build context's `COPY` sources; `""` is the repo root. */
  folders: string[];
}

export interface InfraEnvLink {
  resource: string;
  /** Names the workload sets (its own env, its image's Dockerfile ENV, `.env.example` in the build context). */
  set: string[];
  /** Sources that may set anything — then nothing is reported missing. */
  maybe: string[];
  /** Names the deployed code reads but the workload doesn't set. Empty when `maybe` is not. */
  readNotSet: Array<{ name: string; file: string; line: number }>;
  /** Names it sets that the deployed code doesn't read (shown, not counted). */
  setNotRead: string[];
}

export interface InfraRouteLink {
  resource: string;
  host?: string;
  path: string;
  via: string;
  /** API catalog endpoint ids under the route's path, served by the workload's code when its deploy link is resolved. */
  endpoints: string[];
  /** Auth in front of the route (Traefik forwardauth/basicauth middlewares, ingress auth annotations). */
  auth?: string[];
}

export interface InfraPortLink {
  resource: string;
  /** The port the workload sends traffic to (container port, Nomad `to` / static port). */
  declared: number;
  /** The code's literal listen port, when it has one. */
  listen?: number;
  file?: string;
  line?: number;
  match: boolean;
}

export interface InfraLinks {
  deploys: InfraDeployLink[];
  env: InfraEnvLink[];
  routes: InfraRouteLink[];
  ports: InfraPortLink[];
}

export interface InfraCatalog {
  stacks: InfraStack[];
  resources: InfraResource[];
  moves: InfraMoveBlock[];
  links: InfraLinks;
  /**
   * Env vars the code reads that nothing sets: not the workloads that deploy
   * that file (when one does), not any env source in the repo (when none does),
   * and no "maybe" source covers it. For the App map's explainer.
   */
  envUnset: Array<{ name: string; file: string; line: number }>;
  tools: InfraTool[];
  /** Infra files read (for the empty state). */
  files: number;
}

export const MAX_ATTRS = 80;
export const MAX_ATTR_VALUE = 240;

export const EMPTY_INFRA_CATALOG: InfraCatalog = {
  stacks: [],
  resources: [],
  moves: [],
  links: { deploys: [], env: [], routes: [], ports: [] },
  envUnset: [],
  tools: [],
  files: 0,
};

// ---------------------------------------------------------------------------
// A review target's infra change (./compare.ts)
// ---------------------------------------------------------------------------

/** Plan-style: what `terraform plan` (or a rollout) would do to each resource, as far as static reading can tell. */
export type InfraAction = "create" | "destroy" | "update" | "moved" | "version";

export interface InfraAttrDelta {
  name: string;
  before?: string;
  after?: string;
  /** On the short built-in force-new list: the provider likely replaces the resource. */
  forceNew?: true;
}

export interface InfraChangeEntry {
  /** Head id; the base id for a destroyed resource. */
  id: string;
  action: InfraAction;
  /** At the head (at the base when destroyed). */
  resource: InfraResource;
  /** For update / moved / version: the base version. */
  before?: InfraResource;
  deltas: InfraAttrDelta[];
  /** For moved: the old address, and what moved it (`moved block`, `same name at a new path`). */
  movedFrom?: string;
  movedVia?: string;
  /** For version: before → after. */
  version?: { before?: string; after?: string };
  /** A force-new attribute changed. */
  replace?: true;
  /** Keys of the findings about this entry. */
  findings?: string[];
}

/** A change to a link: an env var newly unset, a route that now reaches other endpoints, a port that no longer matches. */
export interface InfraLinkDelta {
  kind: "env" | "route" | "port" | "deploy";
  /** The workload. */
  resource: string;
  /** One line: "API_KEY is no longer set", "route /api now reaches 3 endpoints (was 5)". */
  text: string;
  /** Code files it concerns. */
  files?: string[];
}

export type InfraFindingRule = "rename-without-moved" | "stateful-destroyed" | "prevent-destroy-removed" | "env-unset";

/** A certain finding, no model call (DESIGN.md §6.12 §5). The target-graph job stores them as `category: "infra"`. */
export interface InfraFinding {
  /** Stable for one target: rule + resource (+ name). */
  key: string;
  rule: InfraFindingRule;
  resource: string;
  file: string;
  line?: number;
  summary: string;
  rationale: string;
}

export interface InfraChange {
  changes: InfraChangeEntry[];
  links: InfraLinkDelta[];
  findings: InfraFinding[];
  counts: { create: number; destroy: number; update: number; moved: number; version: number; findings: number };
  /** Resources at the head — for "N of M". */
  total: number;
}
