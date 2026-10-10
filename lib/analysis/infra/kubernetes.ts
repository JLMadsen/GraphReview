/**
 * Kubernetes manifests, Kustomize and Helm (DESIGN.md §6.12 §2).
 *
 * - Workloads (Deployment, StatefulSet, DaemonSet, Job, CronJob, Pod) with
 *   containers, images, env (literal, `valueFrom` Secret / ConfigMap,
 *   `envFrom`), ports and replicas; Service; Ingress, Gateway API
 *   `HTTPRoute` and Traefik `IngressRoute`; ConfigMap; Secret (key names
 *   only, never values); PVC; HPA; anything else as `other`.
 * - Kustomize: a base is a stack; the overlays that build on it are its
 *   environments. `images`, `replicas`, `namePrefix` / `nameSuffix`,
 *   `namespace` and strategic-merge patches on known fields become values
 *   per environment; any other patch marks its target **patched**.
 * - Helm: one stack per chart (`Chart.yaml`), values files as environments,
 *   dependencies as external rows, and one **templated** row per document of
 *   `templates/` — never rendered.
 * - Plain manifests outside both: one stack per folder.
 */
import { basename, collapse, dirname, flattenValue, STATEFUL_K8S_KINDS } from "./common";
import { traefikRoutes } from "./nomad";
import { normalizePath, splitImage, type HelmTemplateDoc } from "./read";
import type { ResolverFile, ResolverOutput } from "./terraform";
import type { InfraAttr, InfraCategory, InfraResource, InfraStack, InfraWorkload } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const join = (dir: string, rel: string) => normalizePath(dir ? `${dir}/${rel}` : rel);

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "DeploymentConfig", "Rollout"]);

export function k8sCategory(kind: string): InfraCategory {
  if (WORKLOAD_KINDS.has(kind)) return "workload";
  if (kind === "Service") return "service";
  if (kind === "Ingress" || kind === "HTTPRoute" || kind === "GRPCRoute" || kind === "IngressRoute" || kind === "Route") return "route";
  if (kind === "ConfigMap") return "config";
  if (kind === "Secret" || kind === "SealedSecret" || kind === "ExternalSecret") return "secret";
  if (kind === "PersistentVolumeClaim" || kind === "PersistentVolume" || kind === "StorageClass") return "volume";
  if (kind === "HorizontalPodAutoscaler") return "autoscaler";
  return "other";
}

function podSpec(doc: Obj): Obj | undefined {
  const spec = isObj(doc.spec) ? doc.spec : undefined;
  if (!spec) return undefined;
  if (doc.kind === "Pod") return spec;
  if (doc.kind === "CronJob") {
    const jt = isObj(spec.jobTemplate) && isObj(spec.jobTemplate.spec) ? spec.jobTemplate.spec : undefined;
    return jt && isObj(jt.template) && isObj(jt.template.spec) ? jt.template.spec : undefined;
  }
  return isObj(spec.template) && isObj(spec.template.spec) ? spec.template.spec : undefined;
}

function templateLabels(doc: Obj): Obj {
  const spec = isObj(doc.spec) ? doc.spec : {};
  if (doc.kind === "Pod") return isObj(doc.metadata) && isObj(doc.metadata.labels) ? doc.metadata.labels : {};
  const tpl = isObj(spec.template) ? spec.template : {};
  return isObj(tpl.metadata) && isObj(tpl.metadata.labels) ? tpl.metadata.labels : {};
}

/** A document's attributes: everything but identity, with Secret values hidden. */
function docAttributes(doc: Obj): InfraAttr[] {
  const out: InfraAttr[] = [];
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  if (meta.namespace) out.push({ name: "metadata.namespace", value: String(meta.namespace) });
  if (isObj(meta.labels)) flattenValue(meta.labels, "metadata.labels", out);
  if (isObj(meta.annotations)) flattenValue(meta.annotations, "metadata.annotations", out);
  for (const [k, v] of Object.entries(doc)) {
    if (k === "apiVersion" || k === "kind" || k === "metadata") continue;
    if (doc.kind === "Secret" && (k === "data" || k === "stringData") && isObj(v)) {
      for (const key of Object.keys(v)) out.push({ name: `${k}.${key}`, value: "•••" });
      continue;
    }
    flattenValue(v, k, out);
  }
  return out;
}

interface Doc {
  file: string;
  line: number;
  doc: Obj;
  kind: string;
  name: string;
}

/** One manifest document → a row (workload details included). */
function toResource(d: Doc, stack: InfraStack, group: string, configMaps: Map<string, string[]>): InfraResource {
  const address = `${d.kind}/${d.name}`;
  const category = k8sCategory(d.kind);
  const spec = isObj(d.doc.spec) ? d.doc.spec : {};
  const replicas = str(spec.replicas);
  const r: InfraResource = {
    id: `${stack.id}:${address}`,
    tool: "kubernetes",
    stack: stack.id,
    group,
    kind: d.kind,
    category,
    address,
    name: d.name,
    file: d.file,
    line: d.line,
    attributes: docAttributes(d.doc),
    ...(replicas !== undefined ? { count: /^\d+$/.test(replicas) ? replicas : "?" } : {}),
    ...(STATEFUL_K8S_KINDS.has(d.kind) ? { stateful: true as const } : {}),
    refs: [],
  };
  const pod = podSpec(d.doc);
  if (pod) {
    const workload: InfraWorkload = { images: [], env: {}, maybeEnv: [], ports: [], routes: [] };
    for (const c of arr(pod.containers).filter(isObj)) {
      const image = str(c.image);
      if (image) workload.images.push(image);
      for (const e of arr(c.env).filter(isObj)) {
        const name = str(e.name);
        if (!name) continue;
        if (e.value !== undefined) workload.env[name] = collapse(String(e.value), 80);
        else if (isObj(e.valueFrom)) {
          const vf = e.valueFrom;
          if (isObj(vf.secretKeyRef)) workload.env[name] = `secret ${str(vf.secretKeyRef.name) ?? "?"}/${str(vf.secretKeyRef.key) ?? "?"}`;
          else if (isObj(vf.configMapKeyRef)) workload.env[name] = `configmap ${str(vf.configMapKeyRef.name) ?? "?"}/${str(vf.configMapKeyRef.key) ?? "?"}`;
          else workload.env[name] = isObj(vf.fieldRef) ? `field ${str(vf.fieldRef.fieldPath) ?? "?"}` : "valueFrom";
        } else workload.env[name] = "";
      }
      for (const ef of arr(c.envFrom).filter(isObj)) {
        const prefix = str(ef.prefix) ?? "";
        if (isObj(ef.configMapRef)) {
          const cm = str(ef.configMapRef.name) ?? "?";
          const keys = configMaps.get(cm);
          if (keys) for (const k of keys) workload.env[`${prefix}${k}`] ??= `configmap ${cm}`;
          else workload.maybeEnv.push(`envFrom ConfigMap ${cm}`);
          r.refs.push(`${stack.id}:ConfigMap/${cm}`);
        } else if (isObj(ef.secretRef)) {
          const s = str(ef.secretRef.name) ?? "?";
          workload.maybeEnv.push(`envFrom Secret ${s}`);
          r.refs.push(`${stack.id}:Secret/${s}`);
        }
      }
      for (const p of arr(c.ports).filter(isObj)) {
        const port = Number(p.containerPort);
        if (Number.isFinite(port)) workload.ports.push({ ...(str(p.name) ? { name: str(p.name) } : {}), port });
      }
    }
    for (const v of arr(pod.volumes).filter(isObj)) {
      if (isObj(v.persistentVolumeClaim)) r.refs.push(`${stack.id}:PersistentVolumeClaim/${str(v.persistentVolumeClaim.claimName) ?? "?"}`);
      if (isObj(v.configMap)) r.refs.push(`${stack.id}:ConfigMap/${str(v.configMap.name) ?? "?"}`);
      if (isObj(v.secret)) r.refs.push(`${stack.id}:Secret/${str(v.secret.secretName) ?? "?"}`);
    }
    if (workload.images.length) r.source = workload.images[0];
    const tag = workload.images[0] ? splitImage(workload.images[0]).tag : undefined;
    if (tag) r.version = tag;
    r.workload = workload;
  }
  if (d.kind === "HorizontalPodAutoscaler" && isObj(spec.scaleTargetRef)) {
    r.refs.push(`${stack.id}:${str(spec.scaleTargetRef.kind) ?? "?"}/${str(spec.scaleTargetRef.name) ?? "?"}`);
  }
  return r;
}

/** Services → the workloads their selector picks; routes → services → workloads (refs and `workload.routes`). */
function wireServicesAndRoutes(stackResources: InfraResource[], docs: Map<string, Doc>): void {
  const byAddress = new Map(stackResources.map((r) => [r.address, r]));
  const workloads = stackResources.filter((r) => r.workload);
  const servicesTo = new Map<string, InfraResource[]>(); // service name → workloads
  for (const svc of stackResources.filter((r) => r.kind === "Service")) {
    const doc = docs.get(svc.id)?.doc;
    const selector = doc && isObj(doc.spec) && isObj(doc.spec.selector) ? doc.spec.selector : undefined;
    const targets = selector
      ? workloads.filter((w) => {
          const labels = templateLabels(docs.get(w.id)?.doc ?? {});
          return Object.entries(selector).every(([k, v]) => labels[k] === v);
        })
      : [];
    servicesTo.set(svc.name, targets);
    svc.refs.push(...targets.map((t) => t.id));
    // the service's target ports, onto its workloads
    for (const p of arr(doc && isObj(doc.spec) ? doc.spec.ports : []).filter(isObj)) {
      const target = Number(p.targetPort ?? p.port);
      for (const t of targets) if (Number.isFinite(target) && !t.workload!.ports.some((x) => x.port === target)) t.workload!.ports.push({ name: `service ${svc.name}`, port: target });
    }
  }
  const addRoute = (route: InfraResource, serviceName: string, host: string | undefined, path: string, auth: string[]) => {
    const svc = byAddress.get(`Service/${serviceName}`);
    if (svc) route.refs.push(svc.id);
    for (const w of servicesTo.get(serviceName) ?? []) {
      w.workload!.routes.push({ ...(host ? { host } : {}), path, via: `${route.kind} ${route.name}`, ...(auth.length ? { auth } : {}) });
    }
  };
  for (const route of stackResources.filter((r) => r.category === "route")) {
    const doc = docs.get(route.id)?.doc;
    if (!doc) continue;
    const spec = isObj(doc.spec) ? doc.spec : {};
    const annotations = isObj(doc.metadata) && isObj(doc.metadata.annotations) ? doc.metadata.annotations : {};
    const auth = Object.entries(annotations)
      .filter(([k]) => /auth-(url|type|signin|secret)|router\.middlewares|auth\b/.test(k))
      .map(([k, v]) => `${k.split("/").pop()}: ${collapse(String(v), 60)}`);
    if (route.kind === "Ingress") {
      for (const rule of arr(spec.rules).filter(isObj)) {
        const host = str(rule.host);
        for (const p of arr(isObj(rule.http) ? rule.http.paths : []).filter(isObj)) {
          const backend = isObj(p.backend) ? p.backend : {};
          const name = isObj(backend.service) ? str(backend.service.name) : str(backend.serviceName);
          if (name) addRoute(route, name, host, str(p.path) ?? "/", auth);
        }
      }
      const def = isObj(spec.defaultBackend) && isObj(spec.defaultBackend.service) ? str(spec.defaultBackend.service.name) : undefined;
      if (def) addRoute(route, def, undefined, "/", auth);
    } else if (route.kind === "HTTPRoute" || route.kind === "GRPCRoute") {
      const host = arr(spec.hostnames).map(str).find(Boolean);
      for (const rule of arr(spec.rules).filter(isObj)) {
        const paths = arr(rule.matches).filter(isObj).map((m) => (isObj(m.path) ? str(m.path.value) : undefined)).filter((p): p is string => Boolean(p));
        for (const b of arr(rule.backendRefs).filter(isObj)) {
          const name = str(b.name);
          if (name) for (const p of paths.length ? paths : ["/"]) addRoute(route, name, host, p, auth);
        }
      }
    } else if (route.kind === "IngressRoute") {
      for (const rt of arr(spec.routes).filter(isObj)) {
        const rule = str(rt.match) ?? "";
        const host = /Host\(\s*`([^`]+)`/.exec(rule)?.[1];
        const path = /Path(?:Prefix)?\(\s*`([^`]+)`/.exec(rule)?.[1] ?? "/";
        const mws = arr(rt.middlewares).filter(isObj).map((m) => str(m.name) ?? "").filter((m) => /auth/i.test(m));
        for (const s of arr(rt.services).filter(isObj)) {
          const name = str(s.name);
          if (name) addRoute(route, name, host, path, mws.map((m) => `traefik ${m}`));
        }
      }
    }
  }
  // Traefik router labels set as pod annotations (traefik's kubernetes provider via labels is rare, but the format matches Nomad's)
  for (const w of workloads) {
    const doc = docs.get(w.id)?.doc;
    const ann = doc && isObj(doc.metadata) && isObj(doc.metadata.annotations) ? doc.metadata.annotations : {};
    const tags = Object.entries(ann).map(([k, v]) => `${k}=${String(v)}`).filter((t) => t.startsWith("traefik.http."));
    if (tags.length) w.workload!.routes.push(...traefikRoutes(tags, `${w.kind} ${w.name}`));
  }
}

interface Kustomization {
  dir: string;
  file: string;
  doc: Obj;
  children: string[]; // kustomization dirs it builds on
  manifestFiles: string[];
}

/** Known strategic-merge fields a patch may set and still be "applied" as an environment value. */
const KNOWN_PATCH_FIELDS = /^(spec\.replicas|spec\.template\.spec\.containers\[[^\]]+\]\.(name|image|env|resources|ports|args|command)|metadata\.(labels|annotations)|data\.|spec\.template\.metadata\.(labels|annotations))/;

export function resolveKubernetes(files: ResolverFile[]): ResolverOutput {
  const stacks: InfraStack[] = [];
  const resources: InfraResource[] = [];
  const manifests = new Map<string, Doc[]>();
  const kustomizations = new Map<string, Kustomization>();
  const charts = new Map<string, { file: string; doc: Obj }>();
  const values = new Map<string, Array<{ file: string; doc: Obj }>>();
  const templates: Array<{ file: string; docs: HelmTemplateDoc[] }> = [];

  for (const { file, facts } of files) {
    if (facts.kind === "k8s") {
      manifests.set(
        file,
        facts.docs.map((d) => {
          const kind = String(d.doc.kind);
          const meta = isObj(d.doc.metadata) ? d.doc.metadata : {};
          return { file, line: d.line, doc: d.doc, kind, name: str(meta.name) ?? str(meta.generateName) ?? basename(file) };
        })
      );
    } else if (facts.kind === "kustomization") {
      kustomizations.set(dirname(file), { dir: dirname(file), file, doc: facts.doc, children: [], manifestFiles: [] });
    } else if (facts.kind === "chart") {
      charts.set(dirname(file), { file, doc: facts.doc });
    } else if (facts.kind === "values") {
      const list = values.get(dirname(file)) ?? [];
      list.push({ file, doc: facts.doc });
      values.set(dirname(file), list);
    } else if (facts.kind === "helm-template") {
      templates.push({ file, docs: facts.docs });
    }
  }

  // --- Kustomize ---------------------------------------------------------------
  const usedManifests = new Set<string>();
  for (const k of kustomizations.values()) {
    // `components` (kind: Component) are reusable edits an overlay opts into, not bases: they don't make it an overlay.
    const entries = [...arr(k.doc.resources), ...arr(k.doc.bases)].map(str).filter((e): e is string => Boolean(e));
    for (const e of entries) {
      if (/^[a-z]+:\/\/|^github\.com\/|^git@/.test(e)) continue; // remote base: not fetched
      const target = join(k.dir, e);
      if (kustomizations.has(target)) k.children.push(target);
      else if (manifests.has(target)) {
        k.manifestFiles.push(target);
        usedManifests.add(target);
      }
    }
    for (const p of [...arr(k.doc.patchesStrategicMerge), ...arr(k.doc.patches).filter(isObj).map((x) => x.path), ...arr(k.doc.patchesJson6902).filter(isObj).map((x) => x.path)]) {
      const path = str(p);
      if (path && !path.includes("\n")) usedManifests.add(join(k.dir, path));
    }
  }
  const leavesOf = (dir: string, seen = new Set<string>()): string[] => {
    if (seen.has(dir)) return [];
    seen.add(dir);
    const k = kustomizations.get(dir)!;
    if (k.children.length === 0) return [dir];
    return [...new Set(k.children.flatMap((c) => leavesOf(c, seen)))];
  };
  const envName = (dir: string) => {
    const name = basename(dir) || dir || "(root)";
    const clash = [...kustomizations.values()].filter((k) => k.children.length > 0 && basename(k.dir) === name).length > 1;
    return clash ? dir : name;
  };
  const kStacks = new Map<string, InfraStack>();
  const kResources = new Map<string, InfraResource[]>();
  const docById = new Map<string, Doc>();
  // ConfigMaps by name across all manifests and generators (for envFrom).
  const configMaps = new Map<string, string[]>();
  for (const docs of manifests.values()) {
    for (const d of docs) if (d.kind === "ConfigMap" && isObj(d.doc.data)) configMaps.set(d.name, Object.keys(d.doc.data));
  }
  for (const k of kustomizations.values()) {
    for (const g of arr(k.doc.configMapGenerator).filter(isObj)) {
      const name = str(g.name);
      const literals = arr(g.literals).map(str).filter((l): l is string => Boolean(l));
      if (name && arr(g.envs).length === 0 && arr(g.files).length === 0) configMaps.set(name, literals.map((l) => l.split("=")[0]));
    }
  }

  const leafDirs = [...kustomizations.values()].filter((k) => k.children.length === 0).map((k) => k.dir);
  for (const dir of leafDirs.sort()) {
    const k = kustomizations.get(dir)!;
    const stack: InfraStack = { id: `k8s:${dir}`, tool: "kubernetes", path: dir, name: dir || "(root)", kind: k.doc.kind === "Component" ? "kustomize component" : "kustomization", environments: [] };
    stacks.push(stack);
    kStacks.set(dir, stack);
    const list: InfraResource[] = [];
    for (const file of k.manifestFiles) {
      for (const d of manifests.get(file) ?? []) {
        const r = toResource(d, stack, d.kind === "Namespace" ? "(cluster)" : "(base)", configMaps);
        list.push(r);
        docById.set(r.id, d);
      }
    }
    for (const g of arr(k.doc.configMapGenerator).filter(isObj)) {
      const name = str(g.name);
      if (!name) continue;
      const literals = arr(g.literals).map(str).filter((l): l is string => Boolean(l));
      list.push({
        id: `${stack.id}:ConfigMap/${name}`,
        tool: "kubernetes",
        stack: stack.id,
        group: "(base)",
        kind: "ConfigMap",
        category: "config",
        address: `ConfigMap/${name}`,
        name,
        file: k.file,
        line: 1,
        attributes: literals.map((l) => ({ name: `data.${l.split("=")[0]}`, value: collapse(l.split("=").slice(1).join("=")) })),
        refs: [],
      });
    }
    for (const g of arr(k.doc.secretGenerator).filter(isObj)) {
      const name = str(g.name);
      if (!name) continue;
      const literals = arr(g.literals).map(str).filter((l): l is string => Boolean(l));
      list.push({
        id: `${stack.id}:Secret/${name}`,
        tool: "kubernetes",
        stack: stack.id,
        group: "(base)",
        kind: "Secret",
        category: "secret",
        address: `Secret/${name}`,
        name,
        file: k.file,
        line: 1,
        attributes: literals.map((l) => ({ name: `data.${l.split("=")[0]}`, value: "•••" })),
        refs: [],
      });
    }
    // The base's own patches aren't applied: their targets are marked patched.
    markPatched(k, list, manifests);
    kResources.set(dir, list);
  }

  // Overlays: environments of the bases they build on.
  for (const k of kustomizations.values()) {
    if (k.children.length === 0) continue;
    const env = envName(k.dir);
    const leaves = leavesOf(k.dir);
    for (const leaf of leaves) {
      const stack = kStacks.get(leaf);
      const list = kResources.get(leaf);
      if (!stack || !list) continue;
      if (!stack.environments.includes(env)) stack.environments.push(env);
      applyOverlay(k, env, list, manifests);
    }
    // An overlay's own manifests join its first base, marked with the environment.
    const first = leaves.map((l) => kResources.get(l)).find(Boolean);
    const firstStack = leaves.map((l) => kStacks.get(l)).find(Boolean);
    if (first && firstStack) {
      for (const file of k.manifestFiles) {
        for (const d of manifests.get(file) ?? []) {
          const r = toResource(d, firstStack, `overlay ${env}`, configMaps);
          r.id = `${firstStack.id}:${env}/${r.address}`;
          r.attributes.unshift({ name: "only in", value: env });
          first.push(r);
          docById.set(r.id, d);
        }
      }
    }
  }
  for (const list of kResources.values()) {
    wireServicesAndRoutes(list, docById);
    resources.push(...list);
  }

  // --- Helm ---------------------------------------------------------------------
  for (const [dir, chart] of [...charts].sort(([a], [b]) => a.localeCompare(b))) {
    const name = str(chart.doc.name) ?? basename(dir);
    const chartValues = values.get(dir) ?? [];
    const defaults = chartValues.find((v) => /^values\.ya?ml$/i.test(basename(v.file)))?.doc ?? {};
    const envFiles = chartValues.filter((v) => !/^values\.ya?ml$/i.test(basename(v.file)));
    const envOf = (file: string) => basename(file).replace(/^values[-.]?/i, "").replace(/\.ya?ml$/i, "") || basename(file);
    const stack: InfraStack = {
      id: `helm:${dir}`,
      tool: "helm",
      path: dir,
      name,
      kind: "chart",
      environments: envFiles.map((v) => envOf(v.file)).sort(),
      ...(str(chart.doc.version) ? { version: str(chart.doc.version) } : {}),
    };
    stacks.push(stack);
    const group = `chart ${name}`;
    for (const dep of arr(chart.doc.dependencies).filter(isObj)) {
      const depName = str(dep.name);
      if (!depName) continue;
      const repo = str(dep.repository) ?? "";
      resources.push({
        id: `${stack.id}:dependency/${str(dep.alias) ?? depName}`,
        tool: "helm",
        stack: stack.id,
        group,
        kind: "chart dependency",
        category: "chart",
        address: `dependency/${str(dep.alias) ?? depName}`,
        name: depName,
        file: chart.file,
        line: 1,
        attributes: flattenValue(dep, "", []),
        source: repo,
        ...(str(dep.version) ? { version: str(dep.version) } : {}),
        ...(repo.startsWith("file://") ? {} : { external: true as const }),
        ...(dep.condition ? { conditional: true as const } : {}),
        refs: [],
      });
    }
    const valueAt = (doc: Obj, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), doc);
    for (const t of templates.filter((x) => x.file.startsWith(`${dir}/templates/`))) {
      const fileBase = basename(t.file).replace(/\.(ya?ml|tpl)$/i, "");
      const seenInFile = new Map<string, number>();
      for (const d of t.docs) {
        const literalName = d.name && !d.name.includes("{{") ? d.name : undefined;
        // Several documents of one kind in a template (a Service per port) are numbered.
        const plain = `${d.kind}/${literalName ?? fileBase}`;
        const nth = seenInFile.get(plain) ?? 0;
        seenInFile.set(plain, nth + 1);
        const address = nth ? `${plain}#${nth + 1}` : plain;
        const usesImage = d.values.some((v) => v === "image.repository" || v.startsWith("image."));
        const repository = str(valueAt(defaults, "image.repository"));
        const tag = str(valueAt(defaults, "image.tag")) || str(chart.doc.appVersion);
        const category = k8sCategory(d.kind);
        const attributes: InfraAttr[] = d.values.slice(0, 60).map((p) => {
          const v = valueAt(defaults, p);
          return { name: `.Values.${p}`, value: v === undefined ? "(not set)" : collapse(typeof v === "object" ? JSON.stringify(v) : String(v)) };
        });
        const envValues: Record<string, InfraAttr[]> = {};
        for (const ev of envFiles) {
          const list: InfraAttr[] = [];
          for (const p of d.values) {
            const v = valueAt(ev.doc, p);
            if (v !== undefined && JSON.stringify(v) !== JSON.stringify(valueAt(defaults, p))) list.push({ name: `.Values.${p}`, value: collapse(typeof v === "object" ? JSON.stringify(v) : String(v)) });
          }
          if (list.length) envValues[envOf(ev.file)] = list;
        }
        const replicas = d.values.includes("replicaCount") ? str(valueAt(defaults, "replicaCount")) : undefined;
        const r: InfraResource = {
          id: `${stack.id}:${address}`,
          tool: "helm",
          stack: stack.id,
          group,
          kind: d.kind,
          category,
          address,
          name: literalName ?? fileBase,
          file: t.file,
          line: d.line,
          attributes,
          ...(Object.keys(envValues).length ? { envValues } : {}),
          templated: true,
          ...(d.conditional ? { conditional: true as const } : {}),
          ...(replicas ? { count: replicas } : {}),
          ...(STATEFUL_K8S_KINDS.has(d.kind) ? { stateful: true as const } : {}),
          refs: [],
        };
        if (category === "workload") {
          const image = usesImage && repository ? `${repository}${tag ? `:${tag}` : ""}` : undefined;
          r.workload = { images: image ? [image] : [], env: {}, maybeEnv: ["templated chart"], ports: [], routes: [] };
          if (image) r.source = image;
          if (tag) r.version = tag;
        }
        if (resources.some((x) => x.id === r.id)) r.id = `${r.id}#${t.file}`;
        resources.push(r);
      }
    }
  }

  // --- Plain manifests: one stack per folder -------------------------------------------
  const plainByDir = new Map<string, string[]>();
  for (const file of manifests.keys()) {
    if (usedManifests.has(file)) continue;
    const list = plainByDir.get(dirname(file)) ?? [];
    list.push(file);
    plainByDir.set(dirname(file), list);
  }
  for (const [dir, list] of [...plainByDir].sort(([a], [b]) => a.localeCompare(b))) {
    const stack: InfraStack = { id: `k8s:${dir}`, tool: "kubernetes", path: dir, name: dir || "(root)", kind: "manifests", environments: [] };
    if (kStacks.has(dir)) continue; // a kustomization folder's stray files
    stacks.push(stack);
    const out: InfraResource[] = [];
    for (const file of list.sort()) {
      for (const d of manifests.get(file) ?? []) {
        const r = toResource(d, stack, basename(file), configMaps);
        if (out.some((x) => x.id === r.id)) r.id = `${r.id}#${file}`;
        out.push(r);
        docById.set(r.id, d);
      }
    }
    wireServicesAndRoutes(out, docById);
    resources.push(...out);
  }
  return { stacks, resources, moves: [] };
}

/** Targets of a kustomization's patches, as `{kind?, name}`. Strategic-merge patch files say it in their own document. */
function patchTargets(k: Kustomization, manifests: Map<string, Doc[]>): Array<{ kind?: string; name?: string; doc?: Obj; inline?: boolean }> {
  const out: Array<{ kind?: string; name?: string; doc?: Obj; inline?: boolean }> = [];
  for (const p of arr(k.doc.patchesStrategicMerge)) {
    const path = str(p);
    if (path && !path.includes("\n")) for (const d of manifests.get(join(k.dir, path)) ?? []) out.push({ kind: d.kind, name: d.name, doc: d.doc });
    else out.push({ inline: true });
  }
  for (const p of [...arr(k.doc.patches), ...arr(k.doc.patchesJson6902)].filter(isObj)) {
    const target = isObj(p.target) ? p.target : undefined;
    const path = str(p.path);
    const docs = path ? manifests.get(join(k.dir, path)) ?? [] : [];
    if (!target && docs.length) for (const d of docs) out.push({ kind: d.kind, name: d.name, doc: d.doc });
    else out.push({ kind: str(target?.kind), name: str(target?.name) });
  }
  return out;
}

function markPatched(k: Kustomization, list: InfraResource[], manifests: Map<string, Doc[]>): void {
  for (const t of patchTargets(k, manifests)) {
    for (const r of list) if ((!t.kind || r.kind === t.kind) && (!t.name || r.name === t.name) && (t.kind || t.name)) r.patched = true;
  }
}

/** An overlay's edits onto its base's rows, as values for its environment. */
function applyOverlay(k: Kustomization, env: string, list: InfraResource[], manifests: Map<string, Doc[]>): void {
  const add = (r: InfraResource, attr: InfraAttr) => {
    r.envValues ??= {};
    (r.envValues[env] ??= []).push(attr);
  };
  for (const img of arr(k.doc.images).filter(isObj)) {
    const name = str(img.name);
    if (!name) continue;
    for (const r of list) {
      for (const image of r.workload?.images ?? []) {
        if (splitImage(image).image !== name) continue;
        const newName = str(img.newName) ?? name;
        const digest = str(img.digest);
        const tag = str(img.newTag) ?? splitImage(image).tag;
        add(r, { name: "image", value: `${newName}${digest ? `@${digest}` : tag ? `:${tag}` : ""}` });
      }
    }
  }
  for (const rep of arr(k.doc.replicas).filter(isObj)) {
    for (const r of list) if (r.name === str(rep.name) && r.category === "workload") add(r, { name: "spec.replicas", value: String(rep.count) });
  }
  const prefix = str(k.doc.namePrefix) ?? "";
  const suffix = str(k.doc.nameSuffix) ?? "";
  if (prefix || suffix) for (const r of list) if (r.kind !== "Namespace") add(r, { name: "metadata.name", value: `${prefix}${r.name}${suffix}` });
  if (str(k.doc.namespace)) for (const r of list) add(r, { name: "metadata.namespace", value: str(k.doc.namespace)! });
  for (const t of patchTargets(k, manifests)) {
    const targets = list.filter((r) => (!t.kind || r.kind === t.kind) && (!t.name || r.name === t.name) && (t.kind || t.name));
    if (!t.doc) {
      for (const r of targets) r.patched = true;
      continue;
    }
    const attrs = docAttributes(t.doc).filter((a) => a.name !== "metadata.namespace");
    const known = attrs.length > 0 && attrs.every((a) => KNOWN_PATCH_FIELDS.test(a.name));
    for (const r of targets) {
      if (known) for (const a of attrs) add(r, a);
      else r.patched = true;
    }
  }
}
