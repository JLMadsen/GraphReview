/**
 * Shared pieces of the infra resolvers: attributes as text, the built-in
 * lists (stateful kinds, force-new attributes) and small path helpers.
 */
import type { HclBody } from "../syntax/hcl.mjs";
import { MAX_ATTR_VALUE, MAX_ATTRS, type InfraAttr, type InfraResource } from "./types";

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Whitespace collapsed and capped. */
export function collapse(text: string, max = MAX_ATTR_VALUE): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An HCL body's attributes and nested blocks as dotted names (`network.port.http.static`). */
export function flattenHcl(body: HclBody, skip: ReadonlySet<string> = new Set(), prefix = "", out: InfraAttr[] = []): InfraAttr[] {
  for (const a of body.attrs) {
    if (out.length >= MAX_ATTRS) return out;
    if (!prefix && skip.has(a.name)) continue;
    out.push({ name: `${prefix}${a.name}`, value: collapse(a.expr.text) });
  }
  const seen = new Map<string, number>();
  for (const b of body.blocks) {
    if (out.length >= MAX_ATTRS) return out;
    if (!prefix && skip.has(b.type)) continue;
    let key = [b.type, ...b.labels].join(".");
    // repeated unlabelled blocks (`ingress {}` twice) get an index
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) key = `${key}[${n}]`;
    flattenHcl(b.body, skip, `${prefix}${key}.`, out);
  }
  return out;
}

/** A plain JSON-ish value as attributes (`spec.replicas`, `spec.template.spec.containers[0].image`). */
export function flattenValue(value: unknown, prefix: string, out: InfraAttr[], depth = 0): InfraAttr[] {
  if (out.length >= MAX_ATTRS) return out;
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    out.push({ name: prefix || "value", value: collapse(String(value)) });
    return out;
  }
  if (depth >= 8) {
    out.push({ name: prefix, value: collapse(JSON.stringify(value)) });
    return out;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      out.push({ name: prefix, value: collapse(JSON.stringify(value)) });
      return out;
    }
    value.forEach((v, i) => {
      // name a list item by its `name` when it has one (containers, ports, env) — the name is then the key, not an attribute
      const named = v && typeof v === "object" && !Array.isArray(v) && typeof (v as { name?: unknown }).name === "string";
      if (!named) return flattenValue(v, `${prefix}[${i}]`, out, depth + 1);
      const { name, ...rest } = v as { name: string } & Record<string, unknown>;
      if (Object.keys(rest).length === 0) out.push({ name: `${prefix}[${name}]`, value: name });
      else flattenValue(rest, `${prefix}[${name}]`, out, depth + 1);
    });
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flattenValue(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    if (out.length >= MAX_ATTRS) break;
  }
  return out;
}

/** Terraform resource types that hold data. Extensible; never a guess from names. */
const STATEFUL_TERRAFORM = new Set([
  // AWS
  "aws_db_instance", "aws_rds_cluster", "aws_rds_cluster_instance", "aws_rds_global_cluster", "aws_dynamodb_table", "aws_dynamodb_global_table",
  "aws_s3_bucket", "aws_ebs_volume", "aws_efs_file_system", "aws_fsx_lustre_file_system", "aws_elasticache_cluster",
  "aws_elasticache_replication_group", "aws_sqs_queue", "aws_kinesis_stream", "aws_kms_key", "aws_route53_zone", "aws_redshift_cluster",
  "aws_docdb_cluster", "aws_neptune_cluster", "aws_msk_cluster", "aws_opensearch_domain", "aws_elasticsearch_domain", "aws_backup_vault",
  "aws_secretsmanager_secret", "aws_ecr_repository", "aws_glacier_vault", "aws_timestream_database", "aws_memorydb_cluster",
  // Google
  "google_sql_database_instance", "google_sql_database", "google_storage_bucket", "google_compute_disk", "google_compute_region_disk",
  "google_bigquery_dataset", "google_bigquery_table", "google_spanner_instance", "google_spanner_database", "google_pubsub_topic",
  "google_pubsub_subscription", "google_kms_crypto_key", "google_kms_key_ring", "google_dns_managed_zone", "google_redis_instance",
  "google_filestore_instance", "google_firestore_database", "google_bigtable_instance", "google_alloydb_cluster",
  // Azure
  "azurerm_postgresql_server", "azurerm_postgresql_flexible_server", "azurerm_mysql_server", "azurerm_mysql_flexible_server",
  "azurerm_mssql_server", "azurerm_mssql_database", "azurerm_sql_database", "azurerm_cosmosdb_account", "azurerm_storage_account",
  "azurerm_storage_container", "azurerm_storage_share", "azurerm_managed_disk", "azurerm_key_vault", "azurerm_key_vault_key",
  "azurerm_dns_zone", "azurerm_redis_cache", "azurerm_servicebus_queue", "azurerm_servicebus_namespace", "azurerm_eventhub_namespace",
  // Others
  "digitalocean_database_cluster", "digitalocean_volume", "digitalocean_spaces_bucket", "cloudflare_zone", "cloudflare_r2_bucket",
  "kubernetes_persistent_volume_claim", "kubernetes_persistent_volume", "kubernetes_stateful_set", "kubernetes_persistent_volume_claim_v1",
  "kubernetes_persistent_volume_v1", "kubernetes_stateful_set_v1", "nomad_csi_volume", "nomad_csi_volume_registration", "nomad_volume",
  "nomad_external_volume", "vault_mount", "consul_keys", "postgresql_database", "mysql_database", "mongodbatlas_cluster",
  "mongodbatlas_advanced_cluster",
]);

export const STATEFUL_K8S_KINDS = new Set(["StatefulSet", "PersistentVolumeClaim", "PersistentVolume"]);

export function isStatefulTerraform(type: string): boolean {
  return STATEFUL_TERRAFORM.has(type);
}

/** Attributes whose change usually makes the provider replace the resource. A short list, flagged, never predicted. */
const FORCE_NEW: Record<string, string[]> = {
  aws_db_instance: ["engine", "identifier", "availability_zone", "db_subnet_group_name", "kms_key_id", "storage_encrypted", "username"],
  aws_rds_cluster: ["engine", "cluster_identifier", "availability_zones", "database_name", "kms_key_id", "storage_encrypted"],
  aws_instance: ["ami", "availability_zone", "subnet_id", "key_name", "user_data", "private_ip"],
  aws_s3_bucket: ["bucket", "bucket_prefix"],
  aws_dynamodb_table: ["name", "hash_key", "range_key"],
  aws_ebs_volume: ["availability_zone", "snapshot_id", "encrypted"],
  aws_efs_file_system: ["creation_token", "encrypted", "performance_mode"],
  aws_sqs_queue: ["name", "fifo_queue"],
  aws_elasticache_cluster: ["cluster_id", "engine", "subnet_group_name"],
  aws_kms_key: ["key_usage", "customer_master_key_spec"],
  aws_lambda_function: ["function_name"],
  aws_ecr_repository: ["name"],
  Deployment: ["spec.selector.matchLabels"],
  StatefulSet: ["spec.selector.matchLabels", "spec.serviceName", "spec.volumeClaimTemplates"],
  Service: ["spec.clusterIP"],
  PersistentVolumeClaim: ["spec.storageClassName", "spec.accessModes"],
};
/** Provider families where a resource's identity attributes force a new one. */
const FORCE_NEW_PREFIXES: Array<[string, string[]]> = [
  ["google_", ["name", "project", "region", "zone", "location"]],
  ["azurerm_", ["name", "location", "resource_group_name"]],
];

export function isForceNew(kind: string, attr: string): boolean {
  const list = FORCE_NEW[kind];
  if (list?.some((a) => attr === a || attr.startsWith(`${a}.`) || attr.startsWith(`${a}[`))) return true;
  for (const [prefix, attrs] of FORCE_NEW_PREFIXES) if (kind.startsWith(prefix) && attrs.includes(attr)) return true;
  return false;
}

/** A number written as a literal (`3`, `"3"`), else `undefined`. */
export function literalCount(text: string): string | undefined {
  const t = text.trim().replace(/^"|"$/g, "");
  return /^\d+$/.test(t) ? t : undefined;
}

/** `count` / `for_each` text as ×N: a literal number, the size of a literal list / map, or `?`. */
export function countOf(text: string, forEach: boolean): string {
  if (!forEach) return literalCount(text) ?? "?";
  const t = text.trim();
  const inner = /^(?:toset\()?\s*\[([\s\S]*)\]\s*\)?$/.exec(t) ?? /^\{([\s\S]*)\}$/.exec(t);
  if (inner && !/\b(var|local|module|data)\./.test(t)) {
    const items = inner[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return String(items.length);
  }
  return "?";
}

/** `cond ? a : b` somewhere in the text. */
export const isConditional = (text: string) => /\?[^?:]+:/.test(text.replace(/"[^"]*"/g, '""'));

/** Fills `refs` with only the ids that exist. */
export function pruneRefs(resources: InfraResource[]): void {
  const ids = new Set(resources.map((r) => r.id));
  for (const r of resources) r.refs = [...new Set(r.refs)].filter((id) => ids.has(id) && id !== r.id);
}
