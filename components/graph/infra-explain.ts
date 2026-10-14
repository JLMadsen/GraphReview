// Plain-English notes for the Infra view's Files sub-view (DESIGN.md §6.16):
// what a resource is, in words someone who doesn't write Terraform or
// Kubernetes can follow, what it is linked to in the code, and what the
// selected diff does to it. Deterministic: built from the kind, the
// attributes as written and the catalog's links. Nothing is guessed from
// names beyond the short Terraform type table below.

import type { InfraCatalog, InfraChangeEntry, InfraResource } from "./infra-types";
import type { InfraRow } from "./infra-view-model";

export type NoteTone = "plain" | "good" | "warn" | "bad";

export interface NoteLine {
  text: string;
  tone: NoteTone;
}

export interface ResourceNote {
  /** One short sentence: what it is. */
  title: string;
  /** Facts and links, most useful first. */
  lines: NoteLine[];
  /** What the diff does to it, then its findings. */
  change: NoteLine[];
}

const attr = (r: InfraResource, ...names: string[]) => {
  for (const n of names) {
    const a = r.attributes.find((x) => x.name === n);
    if (a) return a.value;
  }
  return undefined;
};

/** Common Terraform types in words. Anything else falls back to the type with its provider prefix dropped. */
const TF_TYPES: Array<[RegExp, string]> = [
  [/_(db_instance|rds_cluster|sql_database_instance|postgresql_(flexible_)?server|mysql_(flexible_)?server)$/, "a managed SQL database"],
  [/_(redis_instance|elasticache_(cluster|replication_group)|redis_cache)$/, "a managed Redis cache"],
  [/_(s3_bucket|storage_bucket|storage_account)$/, "a storage bucket for files"],
  [/_(dynamodb_table|firestore_database|cosmosdb_account)$/, "a managed NoSQL database"],
  [/_(container_cluster|eks_cluster|kubernetes_cluster)$/, "a Kubernetes cluster"],
  [/_(container_node_pool|eks_node_group|kubernetes_cluster_node_pool)$/, "a pool of machines for the Kubernetes cluster"],
  [/_(instance|compute_instance|linux_virtual_machine|windows_virtual_machine)$/, "a virtual machine"],
  [/_(vpc|compute_network|virtual_network)$/, "a private network"],
  [/_(subnet|subnetwork)$/, "a slice of the private network"],
  [/_(security_group|compute_firewall|network_security_group)(_rule)?$/, "firewall rules"],
  [/_(lb|alb|elb|compute_global_forwarding_rule|lb_listener|application_gateway)$/, "a load balancer"],
  [/_(route53_record|dns_record_set|dns_a_record|dns_cname_record|record)$/, "a DNS record"],
  [/_(route53_zone|dns_managed_zone|dns_zone)$/, "a DNS zone"],
  [/_(iam_role|service_account)$/, "an identity the software runs as"],
  [/_(iam_policy|iam_role_policy|iam_member|iam_binding|role_assignment)(_attachment)?$/, "a permission grant"],
  [/_(kms_key|kms_crypto_key|key_vault_key)$/, "an encryption key"],
  [/_(sqs_queue|pubsub_topic|pubsub_subscription|servicebus_queue|sns_topic)$/, "a message queue or topic"],
  [/_(lambda_function|cloudfunctions2?_function|function_app)$/, "a serverless function"],
  [/_(ecr_repository|artifact_registry_repository|container_registry)$/, "a registry for container images"],
  [/_(secretsmanager_secret|secret_manager_secret|key_vault_secret)$/, "a stored secret"],
  [/_(cloudwatch_log_group|logging_\w+)$/, "a place logs are kept"],
  [/_(ecs_service|cloud_run_service|cloud_run_v2_service|container_app)$/, "a hosted container service"],
];

function tfTypeWords(type: string): string {
  for (const [re, words] of TF_TYPES) if (re.test(type)) return words;
  return `a ${type.replace(/^[a-z0-9]+_/, "").replace(/_/g, " ")}`;
}

const provider = (type: string) => type.split("_")[0];

const count = (r: InfraResource) => (r.count === undefined ? undefined : r.count === "?" ? "a number set elsewhere" : r.count);

function copies(r: InfraResource): string {
  const n = count(r);
  if (n === undefined) return "";
  return n === "1" ? " One copy." : ` ${n === "a number set elsewhere" ? "Copies: a number set elsewhere" : `${n} copies`}.`;
}

/** Kubernetes kinds the catalog files under "other". */
const K8S_OTHER: Record<string, string> = {
  ServiceAccount: "An identity the programs run as inside the cluster.",
  Namespace: "A named area of the cluster that groups resources.",
  NetworkPolicy: "Firewall rules: which programs may talk to which.",
  Role: "A set of permissions inside one namespace.",
  ClusterRole: "A set of permissions across the whole cluster.",
  RoleBinding: "Gives an identity the permissions of a Role.",
  ClusterRoleBinding: "Gives an identity the permissions of a ClusterRole.",
  PodDisruptionBudget: "How many copies must stay up during maintenance.",
  AuthorizationPolicy: "Istio rules: who may call which program.",
  ServiceEntry: "Istio: lets programs reach a service outside the cluster.",
  VirtualService: "Istio: how traffic to a service is routed.",
  DestinationRule: "Istio: how traffic to a service is balanced and secured.",
  Gateway: "Where traffic from outside enters the cluster.",
  Certificate: "A TLS certificate kept up to date for you.",
  ServiceMonitor: "Tells Prometheus to collect a program's metrics.",
  PriorityClass: "How important programs are when the cluster runs short.",
  LimitRange: "Default and maximum sizes for programs in a namespace.",
  ResourceQuota: "A cap on what a namespace may use in total.",
  Kustomization: "Kustomize: which files make up this deploy set and what to change in them.",
  Component: "Kustomize: an optional add-on to a deploy set.",
};

/** What the resource is, in one sentence. */
export function explainTitle(r: InfraResource): string {
  const k = r.kind.replace(/ \(.*\)$/, "");
  switch (r.category) {
    case "workload":
      if (k === "StatefulSet") return `Runs a program that keeps its own disk per copy.${copies(r)}`;
      if (k === "DaemonSet") return "Runs one copy of a program on every machine in the cluster.";
      if (k === "CronJob") return `Runs a program on a schedule (${attr(r, "spec.schedule", "schedule") ?? "see file"}).`;
      if (k === "Job") return "Runs a program once, until it finishes.";
      if (k === "Pod") return "Runs a program directly, with nothing to restart it elsewhere if its machine goes away.";
      return `Keeps a program running and restarts it if it crashes.${copies(r)}`;
    case "service": {
      const type = r.attributes.find((x) => x.name === "spec.type")?.value;
      if (type === "LoadBalancer") return "Gives the program's copies one stable address, and a public one outside the cluster through a cloud load balancer.";
      if (type === "NodePort") return "Gives the program's copies one stable address, and opens a port on every cluster machine so it can be reached from outside.";
      return "Gives the program's copies one stable address inside the cluster.";
    }
    case "route":
      return "Lets traffic from outside reach a service, by host name and path.";
    case "config":
      return "Plain settings handed to programs.";
    case "secret":
      return "Secret values handed to programs (only the key names are read here).";
    case "volume":
      return "A disk: data on it survives restarts.";
    case "autoscaler":
      return `Adds or removes copies as load changes (${attr(r, "spec.minReplicas") ?? "?"}–${attr(r, "spec.maxReplicas") ?? "?"}).`;
    case "job":
      return `A Nomad job: a ${attr(r, "type") ?? "service"} made of groups of tasks${attr(r, "datacenters") ? `, in ${attr(r, "datacenters")}` : ""}.`;
    case "group":
      return `Tasks that always run together on one machine.${copies(r)}`;
    case "task":
      return `One program, run by Nomad's ${r.kind.match(/\((.*)\)/)?.[1] ?? "?"} driver.`;
    case "stage":
      return `A build step, starting from ${attr(r, "from") ?? r.source ?? "another image"}.`;
    case "image":
      return `A ready-made image pulled from a registry${r.version ? ` (${r.version})` : ""}.`;
    case "chart":
      return `A Helm chart this chart pulls in${r.version ? ` (${r.version})` : ""}; its contents aren't read.`;
    case "resource":
      return `Creates ${tfTypeWords(r.kind)} (${provider(r.kind)}).${r.count !== undefined && r.count !== "1" ? ` ×${r.count}.` : ""}`;
    case "data":
      return `Looks up an existing ${tfTypeWords(r.kind).replace(/^an? /, "")} — reads it, doesn't create it.`;
    case "module":
      return r.external
        ? `Uses a module from ${r.source ?? "outside the repo"}${r.version ? ` (${r.version})` : ""}: a bundle of resources that isn't fetched, so what it creates is unknown.`
        : `Uses the module in ${r.source ?? "?"}: a reusable bundle of resources, listed under ${r.address}.`;
    case "variable":
      return "An input that can differ per environment.";
    case "output":
      return "A value this stack hands to whoever uses it.";
    case "local":
      return "A named value worked out here and reused below.";
    case "provider":
      return `Which ${r.name} account and region Terraform works in.`;
    default:
      return K8S_OTHER[k] ?? `A ${k}.`;
  }
}

/** The note beside a resource's lines. `catalog` is the analysed catalog (for the links). */
export function explainResource(row: InfraRow, catalog: InfraCatalog | null): ResourceNote {
  const r = row.resource;
  const lines: NoteLine[] = [];
  const plain = (text: string) => lines.push({ text, tone: "plain" });

  const deploy = catalog?.links.deploys.find((d) => d.resource === r.id);
  const env = catalog?.links.env.find((e) => e.resource === r.id);
  const ports = catalog?.links.ports.filter((p) => p.resource === r.id) ?? [];
  const routes = catalog?.links.routes.filter((x) => x.resource === r.id) ?? [];

  if (r.workload) {
    const img = r.workload.images[0];
    if (deploy?.resolved) plain(`Runs ${img ?? "an image"}, built from ${deploy.dockerfile ?? deploy.folders.join(", ")} — so it ships the code in ${deploy.folders.map((f) => f || "the repo root").join(", ")}.`);
    else if (img) lines.push({ text: `Runs ${img}. Which code that is couldn't be told: ${deploy?.via ?? "no link"}.`, tone: "warn" });
    for (const p of ports) {
      if (p.listen === undefined) plain(`Sends traffic to port ${p.declared}.`);
      else if (p.match) lines.push({ text: `Port ${p.declared} matches the code, which listens on ${p.listen}.`, tone: "good" });
      else lines.push({ text: `Port ${p.declared}, but the code listens on ${p.listen} (${p.file}:${p.line}).`, tone: "warn" });
    }
    for (const x of routes) plain(`Reachable at ${x.host ?? ""}${x.path}${x.endpoints.length ? `, serving ${x.endpoints.length} endpoint${x.endpoints.length === 1 ? "" : "s"}` : ""}${x.auth?.length ? `, behind ${x.auth.join(", ")}` : ""}.`);
    if (env) {
      if (env.readNotSet.length) lines.push({ text: `The code reads ${env.readNotSet.map((e) => e.name).join(", ")}, which nothing here sets.`, tone: "bad" });
      // The links are the analysed commit's: with a diff, `r` is the head's
      // version, so a name the diff stops setting isn't listed as set.
      const setNotRead = env.setNotRead.filter((name) => !r.workload || name in r.workload.env);
      if (setNotRead.length) plain(`Sets ${setNotRead.join(", ")}, which the code never reads.`);
      if (env.set.length && !env.readNotSet.length) lines.push({ text: `Sets ${env.set.length} setting${env.set.length === 1 ? "" : "s"} the code needs${env.maybe.length ? `, plus whatever ${env.maybe.join(", ")} holds` : ""}.`, tone: "good" });
    }
    if (r.workload.secrets?.length) plain(`Reads secrets from ${r.workload.secrets.join(", ")}.`);
  }
  if (r.category === "config" || r.category === "secret") {
    const keys = r.attributes.filter((a) => a.name.startsWith("data.") || a.name.startsWith("stringData.")).map((a) => a.name.replace(/^(string)?[dD]ata\./, ""));
    if (keys.length) plain(`Keys: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? `, +${keys.length - 8} more` : ""}.`);
  }
  if (r.category === "variable") {
    const d = attr(r, "default");
    plain(d !== undefined ? `Default: ${d}.` : "No default: every environment must set it.");
    for (const [envName, values] of Object.entries(r.envValues ?? {})) {
      const v = values.find((x) => x.name === "value" || x.name === "default");
      if (v) plain(`In ${envName}: ${v.value}.`);
    }
  }
  if (r.stateful) lines.push({ text: "Holds data: deleting it loses what's in it.", tone: "warn" });
  if (r.lifecycle?.preventDestroy) lines.push({ text: "Protected: Terraform refuses to delete it.", tone: "good" });
  if (r.conditional) plain("Only created when a condition holds.");
  if (r.templated) plain("A template: shown as written, never filled in.");
  if (r.patched) plain("A Kustomize patch changes it in some environment; that isn't applied here.");

  return { title: explainTitle(r), lines, change: explainChange(row) };
}

/** What the diff does to a row, then its findings — empty when the diff leaves it alone. */
export function explainChange(row: InfraRow): NoteLine[] {
  const out: NoteLine[] = [];
  const c: InfraChangeEntry | undefined = row.change;
  const r = row.resource;
  if (c?.action === "create") out.push({ text: "Added by this change.", tone: "good" });
  if (c?.action === "destroy") out.push({ text: `Removed by this change: applying it deletes it${r.stateful ? ", and the data in it" : ""}.`, tone: "bad" });
  if (c?.action === "moved") out.push({ text: `Moved from ${c.movedFrom}${c.movedVia ? ` (${c.movedVia})` : ""} — kept, not recreated.`, tone: "plain" });
  if (c?.action === "version") out.push({ text: `Version ${c.version?.before ?? "?"} → ${c.version?.after ?? "?"}.`, tone: "warn" });
  if (c?.action === "update") {
    for (const d of c.deltas.slice(0, 6)) {
      const name = d.name.replace(/^spec\.template\.spec\./, "");
      const text =
        d.before === undefined ? `Adds ${name} = ${d.after}.` : d.after === undefined ? `Removes ${name} (was ${d.before}).` : `Changes ${name}: ${d.before} → ${d.after}.`;
      out.push({ text: d.forceNew ? `${text} This likely recreates it.` : text, tone: d.forceNew || d.after === undefined ? "warn" : "plain" });
    }
    if (c.deltas.length > 6) out.push({ text: `And ${c.deltas.length - 6} more changes.`, tone: "plain" });
  }
  for (const f of row.findings) out.push({ text: f.summary, tone: "bad" });
  return out;
}
