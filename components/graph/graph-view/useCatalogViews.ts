// The state behind the Graph tab's catalog views — the App map (DESIGN.md
// §6.5), API (§6.11), Infra (§6.12) and Data (§6.13): each view's catalog,
// its rows with the selected diff's change folded in, and what is focused or
// selected in it. GraphView decides when each loads (a view loads the first
// time it is opened, and some load early because another view reads them).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppMap, useAppMapCardActions, useAppMapJob } from "../useAppMap";
import { isAppMapLevel, type AppMapLevel } from "../app-map-types";
import type { AppMapSelection } from "../AppMapPanel";
import { useApiCatalog } from "../useApiCatalog";
import { buildApiRows } from "../api-view-model";
import { useInfraCatalog } from "../useInfraCatalog";
import { buildInfraRows, gatewayAuth } from "../infra-view-model";
import { useDbSchema } from "../useDbSchema";
import { useEnvCatalog } from "../useEnvCatalog";
import { buildDbRows, endpointTouches, tableLabel, tablesByFile } from "../db-view-model";
import type { DataMode } from "../DataView";
import type { TargetGraphData } from "../target-graph-types";
import type { ReviewTargetDTO } from "../types";
import { useStoredState } from "./view-state";

const APP_LEVEL_STORAGE_KEY = "graphreview.appmap.level";
const DATA_MODE_STORAGE_KEY = "graphreview.data.mode";

const parseAppLevel = (raw: string | null) => (isAppMapLevel(raw) ? raw : undefined);
const parseDataMode = (raw: string | null): DataMode | undefined => (raw === "list" ? "list" : undefined);

/** An item asked for from elsewhere (a link in the left column, another view) — the view opens it and scrolls to it. */
export type ViewFocus = { id: string } | null;

/** The App map: its level (remembered per browser), the map, its AI run and card actions, and the selected card or link. */
export function useAppMapViewState(repoId: string, load: boolean, graphNonce: number) {
  const [level, storeLevel] = useStoredState<AppMapLevel>(APP_LEVEL_STORAGE_KEY, "architecture", parseAppLevel);
  const [runNonce, setRunNonce] = useState(0);
  const map = useAppMap(repoId, level, load, `${graphNonce}:${runNonce}`);
  const handleRunCompleted = useCallback(() => setRunNonce((n) => n + 1), []);
  const job = useAppMapJob(repoId, load, handleRunCompleted);
  const cardActions = useAppMapCardActions(repoId, job, handleRunCompleted);
  const [selection, setSelection] = useState<AppMapSelection | null>(null);
  // A connection row hovered in the app-map panel; its line is lit on the map.
  const [hoveredLink, setHoveredLink] = useState<string | null>(null);
  const setLevel = useCallback(
    (next: AppMapLevel) => {
      storeLevel(next);
      setSelection(null);
    },
    [storeLevel]
  );
  useEffect(() => setSelection(null), [repoId]);
  return { level, setLevel, map, job, cardActions, selection, setSelection, hoveredLink, setHoveredLink };
}

/**
 * The API view. With a diff selected it lists only the diff's API changes;
 * "All endpoints" (`changedOnly` off) shows the whole catalog with them marked.
 */
export function useApiViewState(
  repoId: string,
  load: boolean,
  graphNonce: number,
  reviewTarget: ReviewTargetDTO | null,
  targetData: TargetGraphData | undefined
) {
  const catalog = useApiCatalog(repoId, load, graphNonce);
  const change = targetData?.api;
  const rows = useMemo(() => buildApiRows(catalog.catalog, change), [catalog.catalog, change]);
  const [focus, setFocus] = useState<ViewFocus>(null);
  const [changedOnly, setChangedOnly] = useState(true);
  useEffect(() => setFocus(null), [repoId]);
  useEffect(() => setChangedOnly(true), [reviewTarget]);
  /** "GET /orders/{id}" for an endpoint id, from the catalog when it is loaded. */
  const endpointLabel = useCallback(
    (id: string) => {
      const e = catalog.catalog?.endpoints.find((x) => x.id === id);
      return e ? `${e.method} ${e.path}` : id.replace(/^http /, "");
    },
    [catalog.catalog]
  );
  return { catalog, change, rows, focus, setFocus, changedOnly, setChangedOnly, endpointLabel };
}

/** The Infra view; also read for the App map's explainer ("Deployed as") and the API view's gateway auth. */
export function useInfraViewState(
  repoId: string,
  load: boolean,
  graphNonce: number,
  reviewTarget: ReviewTargetDTO | null,
  targetData: TargetGraphData | undefined
) {
  const catalog = useInfraCatalog(repoId, load, graphNonce);
  const change = targetData?.infra;
  const rows = useMemo(() => buildInfraRows(catalog.catalog, change), [catalog.catalog, change]);
  const endpointGatewayAuth = useMemo(() => gatewayAuth(catalog.catalog), [catalog.catalog]);
  const [focus, setFocus] = useState<ViewFocus>(null);
  const [changedOnly, setChangedOnly] = useState(true);
  useEffect(() => setFocus(null), [repoId]);
  useEffect(() => setChangedOnly(true), [reviewTarget]);
  return { catalog, change, rows, endpointGatewayAuth, focus, setFocus, changedOnly, setChangedOnly };
}

/** The Env view (DESIGN.md §6.15): the catalog, the diff's change, a focused name, "Env changes" vs "All variables". */
export function useEnvViewState(repoId: string, load: boolean, graphNonce: number, reviewTarget: ReviewTargetDTO | null, targetData: TargetGraphData | undefined) {
  const catalog = useEnvCatalog(repoId, load, graphNonce);
  const change = targetData?.env;
  const [focus, setFocus] = useState<ViewFocus>(null);
  const [changedOnly, setChangedOnly] = useState(true);
  useEffect(() => setFocus(null), [repoId]);
  useEffect(() => setChangedOnly(true), [reviewTarget]);
  return { catalog, change, focus, setFocus, changedOnly, setChangedOnly };
}

/**
 * The Data view: the schema as an ER canvas or a list (remembered per
 * browser), the selected table and its explainer. Also read for the API
 * explainer's "touches" and the PR map's ⛁ badges.
 */
export function useDataViewState(
  repoId: string,
  load: boolean,
  graphNonce: number,
  reviewTarget: ReviewTargetDTO | null,
  targetData: TargetGraphData | undefined
) {
  const schema = useDbSchema(repoId, load, graphNonce);
  const change = targetData?.db;
  const rows = useMemo(() => buildDbRows(schema.schema, change), [schema.schema, change]);
  const tablesById = useMemo(() => new Map(rows.map((r) => [r.table.id, r.table])), [rows]);
  const endpointTables = useMemo(() => endpointTouches(schema.schema), [schema.schema]);
  /** Table names by file, for the PR map's ⛁ badges. */
  const fileTableNames = useMemo(() => {
    const names = new Map((schema.schema?.databases ?? []).flatMap((d) => d.tables.map((t) => [t.id, tableLabel(t)] as const)));
    const out = new Map<string, string[]>();
    for (const [file, ids] of tablesByFile(schema.schema)) out.set(file, [...ids].map((id) => names.get(id) ?? id));
    // Migrations only the diff adds aren't in the analysed catalog: the change says what they touch.
    for (const c of change?.tables ?? []) {
      for (const m of c.migrations) {
        const file = m.split("#")[0];
        const list = out.get(file) ?? [];
        if (!list.includes(tableLabel(c.table))) out.set(file, [...list, tableLabel(c.table)]);
      }
    }
    return out;
  }, [schema.schema, change]);
  const [focus, setFocus] = useState<ViewFocus>(null);
  const [changedOnly, setChangedOnly] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useStoredState<DataMode>(DATA_MODE_STORAGE_KEY, "canvas", parseDataMode);
  useEffect(() => {
    setFocus(null);
    setSelected(null);
  }, [repoId]);
  useEffect(() => setChangedOnly(true), [reviewTarget]);
  const selectedRow = selected ? rows.find((r) => r.table.id === selected) : undefined;
  return {
    schema,
    change,
    rows,
    tablesById,
    endpointTables,
    fileTableNames,
    focus,
    setFocus,
    changedOnly,
    setChangedOnly,
    selected,
    setSelected,
    selectedRow,
    mode,
    setMode,
  };
}
