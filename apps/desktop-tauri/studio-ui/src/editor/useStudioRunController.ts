import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Edge, Node } from "@xyflow/react";

import type { HgripeNodeData } from "./HgripeNode";
import { toWorkflowGraph } from "./adapter";
import { psdExportTargets, psdTemplatePaths, validatePsdChain } from "./psdcheck";
import { validateBackendRefs } from "../models/backendBindings";
import { loadRegistry } from "../models/backendRegistry";
import {
  appendLog,
  describeNodeStatus,
  formatLogText,
  levelForStatus,
  type LogLevel,
  type RunLogEntry,
} from "./runlog";
import {
  addRunRecord,
  loadRunHistory,
  newRunRecordId,
  parseRunHistory,
  saveRunHistory,
  type RunKind,
  type RunOutcome,
  type RunRecord,
} from "./runhistory";
import { buildRunReport } from "./runReport";
import { useProjectScopedStore } from "./useProjectScopedStore";
import { lowerWorkflowGraph, originNodeId } from "../graph/lowering";
import type { WorkflowGraph } from "../graph/model";
import { parseLayeredImageAsset } from "../production/layeredImage";
import { runGraph, type NodeRunInfo, type NodeStatus } from "../runtime/dag";
import { describeDeviceReport, deviceReportFromNodeOutputs } from "../runtime/deviceReport";
import { describeRunScope, resolveRunScope, type RunScope } from "../runtime/runScope";
import { batchItems, defaultExecutors } from "../runtime/executors";
import {
  cancelStudioRun,
  createStudioRunId,
  inspectPsd,
  isTauri,
  readStudioRunHistory,
  runStudioGraph,
  writeStudioRunHistory,
  type StudioGraphRunEvent,
  type StudioGraphRunResult,
} from "../bridge/tauri";

// The run controller always executes the active canvas's live graph, so its
// scopes carry this fixed canvas marker instead of a real canvas lookup key.
const ACTIVE_CANVAS = "active";

const NODE_STATUSES = new Set<NodeStatus>([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cached",
  "skipped",
]);

function toNodeStatus(status: string): NodeStatus {
  return NODE_STATUSES.has(status as NodeStatus) ? (status as NodeStatus) : "failed";
}

function studioOutputsToMap(
  result: StudioGraphRunResult,
): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(result.outputs));
}

function graphWithParamOverrides(
  graph: WorkflowGraph,
  nodeId: string,
  params: Record<string, unknown>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, params: { ...node.params, ...params } } : node,
    ),
  };
}

/** One open canvas as submitted to the project-level batch run. */
export interface ProjectRunCanvas {
  id: string;
  /** Display title for the run log (file stem or "untitled"). */
  title: string;
  /** True for the active tab: statuses/previews land on the visible cards. */
  active: boolean;
  graph: WorkflowGraph;
}

export interface StudioRunControllerOptions {
  /** Live editor graph (used to build the workflow to run). */
  nodes: Node[];
  edges: Edge[];
  /** React Flow node setter, for applying statuses/outputs back onto cards. */
  setNodes: Dispatch<SetStateAction<Node[]>>;
  /** Patch a single node's data (status, duration, preview paths, …). */
  patchNode: (id: string, patch: Partial<HgripeNodeData>) => void;
  /** Select/focus a node in the editor (used to surface the first failure). */
  focusNode: (nodeId: string) => void;
  /** Surface a status-bar message. */
  setMessage: (message: string) => void;
  /** Auto-capture a snapshot before a run (when enabled). */
  autoSnapshotBeforeRun: () => void;
  /** Sink folder for project-scoped run history (null → localStorage). */
  projectStoreDir: string | null;
}

export interface StudioRunController {
  /** True while a run/batch is in flight. */
  running: boolean;
  /** Active Rust run id (desktop), or null. */
  currentRunId: string | null;
  /** Whether the in-flight run can be cancelled (true for either backend). */
  canCancel: boolean;
  /** Append-only run log (capped). */
  runLog: RunLogEntry[];
  showLog: boolean;
  setShowLog: Dispatch<SetStateAction<boolean>>;
  clearLog: () => void;
  /** Download the run log as a plain-text file. */
  exportLog: () => void;
  /** Persisted run history (project-scoped). */
  runHistory: RunRecord[];
  showHistory: boolean;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  /** Clear all run history (prompts when non-empty). */
  clearHistory: () => void;
  /** Run the current graph once. */
  run: () => Promise<void>;
  /** Run only `nodeId` and its transitive inputs, then surface its result. */
  runUpToNode: (nodeId: string) => Promise<void>;
  /** Run an explicit scope (selection, card, downstream, …) on the active canvas. */
  runScope: (scope: RunScope) => Promise<void>;
  /** Run one semantic row of an integrated card (its input chain only). */
  runCardRow: (nodeId: string, rowId: string) => Promise<void>;
  /** Run an integrated card (its wired rows) plus its upstream chain. */
  runCard: (nodeId: string) => Promise<void>;
  /** Run the selected nodes plus their upstream dependencies. */
  runSelection: (nodeIds: string[]) => Promise<void>;
  /** Run exactly the selected nodes, warning about cut-away inputs. */
  runSelectionOnly: (nodeIds: string[]) => Promise<void>;
  /** Run `nodeId` and everything downstream of it (explicit downstream run). */
  runNodeDownstream: (nodeId: string) => Promise<void>;
  /** Run the graph once per item of the (first) batch node. */
  runBatch: () => Promise<void>;
  /** Project-level batch: run every open canvas's graph sequentially. */
  runProject: (canvases: ProjectRunCanvas[]) => Promise<void>;
  /** Request cancellation of the active run (Rust backend or browser preview). */
  cancelRun: () => void;
  /** Whether the graph contains a batch node. */
  hasBatch: boolean;
  /** Number of items the batch node fans out to. */
  batchCount: number;
}

// Owns the studio run lifecycle along with its run log and run history:
// executes the graph (Rust backend on desktop, browser-preview executors
// otherwise), streams per-node status into the log, finalizes each run into a
// persisted history record, and exposes the log/history view toggles. The
// editor (graph mutation, file/project state) stays in the caller and is
// reached through the supplied callbacks.
export function useStudioRunController({
  nodes,
  edges,
  setNodes,
  patchNode,
  focusNode,
  setMessage,
  autoSnapshotBeforeRun,
  projectStoreDir,
}: StudioRunControllerOptions): StudioRunController {
  const [running, setRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [runHistory, setRunHistory] = useState<RunRecord[]>(() => loadRunHistory());
  const [showHistory, setShowHistory] = useState(false);

  // True from the moment a run/batch starts until it settles. Guards against
  // re-entrancy (e.g. the keyboard shortcut firing while a run is in flight),
  // which would otherwise let two runs clobber each other's refs and history.
  const inFlight = useRef(false);
  // Cooperative cancel token for the active browser-preview run (no server-side
  // cancel exists for that backend); null when no browser run is in flight.
  const browserCancel = useRef<{ cancelled: boolean } | null>(null);
  // While a run is in flight this collects that run's log entries so they can
  // be saved as a RunRecord when it ends; null when no run is active.
  const runEntriesRef = useRef<RunLogEntry[] | null>(null);
  const logSeq = useRef(0);
  // Node ids that reported "failed" during the in-flight run, in first-seen order.
  const runFailures = useRef<string[]>([]);
  const currentRunIdRef = useRef<string | null>(null);
  // Lowered (hidden) node id -> visible card id for the in-flight run, so
  // statuses/logs from lowered rows land on the card that owns them.
  const loweredOrigin = useRef<Map<string, string>>(new Map());

  const mapRunNodeId = useCallback(
    (id: string) => originNodeId(loweredOrigin.current, id),
    [],
  );

  const setStatus = useCallback(
    (id: string, status: NodeStatus) => patchNode(id, { status }),
    [patchNode],
  );

  // Append a line to the run log (capped, never mutating the previous array).
  const pushLog = useCallback((level: LogLevel, message: string, node?: string) => {
    const entry: RunLogEntry = { id: logSeq.current++, t: Date.now(), level, message, node };
    setRunLog((log) => appendLog(log, entry));
    if (runEntriesRef.current) runEntriesRef.current.push(entry);
  }, []);

  // Finalize the in-flight run into a persisted history record. Promotes a
  // nominal "succeeded" to "failed" when any node reported a failure.
  const recordRunHistory = useCallback(
    (kind: RunKind, startedAt: number, outcome: RunOutcome, backend: string) => {
      const entries = runEntriesRef.current ?? [];
      runEntriesRef.current = null;
      const failedNodes = runFailures.current.length;
      const finalOutcome: RunOutcome =
        outcome === "succeeded" && failedNodes > 0 ? "failed" : outcome;
      const record: RunRecord = {
        id: newRunRecordId(),
        kind,
        startedAt,
        endedAt: Date.now(),
        outcome: finalOutcome,
        backend,
        failedNodes,
        entries,
      };
      setRunHistory((h) => addRunRecord(h, record));
    },
    [],
  );

  // Download the run log as a plain-text file (browser + desktop webview).
  const exportLog = useCallback(() => {
    const blob = new Blob([formatLogText(runLog)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "run-log.txt";
    a.click();
    URL.revokeObjectURL(url);
  }, [runLog]);

  // After a run settles, surface any failed nodes: select/focus the first one
  // and summarise them in the log. Returns the number of failed nodes.
  const highlightFailures = useCallback(() => {
    const failed = runFailures.current;
    if (failed.length === 0) return 0;
    focusNode(failed[0]);
    pushLog("error", `⚠ ${failed.length} node(s) failed: ${failed.join(", ")}`);
    return failed.length;
  }, [focusNode, pushLog]);

  // Per-node run telemetry (duration / error) for node-level logs/progress.
  const recordRun = useCallback(
    (id: string, info: NodeRunInfo) => {
      patchNode(id, { durationMs: info.durationMs, error: info.error ?? null });
      if (info.status === "failed" && !runFailures.current.includes(id)) {
        runFailures.current.push(id);
      }
      pushLog(
        levelForStatus(info.status),
        describeNodeStatus(info.status, { durationMs: info.durationMs, error: info.error }),
        id,
      );
    },
    [patchNode, pushLog],
  );

  // Clear the previous run's duration/error before a fresh run.
  const clearRunInfo = useCallback(
    () => setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, durationMs: undefined, error: undefined } }))),
    [setNodes],
  );
  const observer = useMemo(
    () => ({
      onStatus: (id: string, status: NodeStatus) => setStatus(mapRunNodeId(id), status),
      onNodeRun: (id: string, info: NodeRunInfo) => recordRun(mapRunNodeId(id), info),
    }),
    [setStatus, recordRun, mapRunNodeId],
  );

  const applyStudioRunResult = useCallback(
    (result: StudioGraphRunResult) => {
      const statuses = new Map(
        Object.entries(result.statuses).map(([id, status]) => [mapRunNodeId(id), toNodeStatus(status)]),
      );
      const runs = new Map(result.node_runs.map((run) => [mapRunNodeId(run.node_id), run]));
      setNodes((ns) =>
        ns.map((n) => {
          const d = n.data as HgripeNodeData;
          const runInfo = runs.get(n.id);
          return {
            ...n,
            data: {
              ...d,
              status: statuses.get(n.id) ?? d.status,
              durationMs: runInfo ? runInfo.duration_ms ?? undefined : d.durationMs,
              error: runInfo ? runInfo.error ?? null : d.error,
            },
          };
        }),
      );
    },
    [setNodes, mapRunNodeId],
  );

  const applyStudioRunEvent = useCallback(
    (rawEvent: StudioGraphRunEvent) => {
      const event = rawEvent.node_id
        ? { ...rawEvent, node_id: mapRunNodeId(rawEvent.node_id) }
        : rawEvent;
      if (!event.node_id) {
        if (event.message) pushLog("info", event.message);
        return;
      }
      // Progress lines from executors (`status: "log"`) only feed the run log;
      // they never change the node's lifecycle status.
      if (event.status === "log") {
        if (event.message) pushLog("info", event.message, event.node_id);
        return;
      }
      const status = toNodeStatus(event.status);
      if (status === "failed" && !runFailures.current.includes(event.node_id)) {
        runFailures.current.push(event.node_id);
      }
      pushLog(
        levelForStatus(status),
        describeNodeStatus(status, {
          durationMs: event.duration_ms,
          error: event.error,
          detail: event.error_detail,
        }),
        event.node_id,
      );
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== event.node_id) return n;
          const d = n.data as HgripeNodeData;
          const isFreshStatus = status === "queued" || status === "running";
          return {
            ...n,
            data: {
              ...d,
              status,
              durationMs: event.duration_ms ?? (isFreshStatus ? undefined : d.durationMs),
              error: event.error ?? (isFreshStatus ? undefined : d.error),
            },
          };
        }),
      );
    },
    [setNodes, pushLog, mapRunNodeId],
  );

  const beginRustRun = useCallback(() => {
    const runId = createStudioRunId();
    currentRunIdRef.current = runId;
    setCurrentRunId(runId);
    return runId;
  }, []);

  const endRustRun = useCallback((runId: string) => {
    if (currentRunIdRef.current !== runId) return;
    currentRunIdRef.current = null;
    setCurrentRunId(null);
  }, []);

  const cancelRun = useCallback(() => {
    const runId = currentRunIdRef.current;
    if (runId) {
      setMessage("cancelling…");
      pushLog("warn", "✋ cancellation requested");
      void cancelStudioRun(runId).catch((err) => setMessage(`cancel failed: ${String(err)}`));
      return;
    }
    // Browser-preview runs have no backend to call: flip the cooperative token
    // so runGraph aborts before its next node.
    if (browserCancel.current) {
      browserCancel.current.cancelled = true;
      setMessage("cancelling…");
      pushLog("warn", "✋ cancellation requested");
    }
  }, [pushLog, setMessage]);

  // Per-node device transparency (GPU_DEVICE_STRATEGY_PLAN steps 4–5): after
  // a run, surface each node's requested/used device and fallback reason in
  // the run log, and pin the report onto the card so the header badge and
  // Inspector show it, normalised into the shared DeviceReport vocabulary.
  const logDeviceReports = useCallback(
    (outputs: Map<string, Record<string, unknown>>) => {
      for (const [nodeId, nodeOutputs] of outputs) {
        const report = deviceReportFromNodeOutputs(nodeOutputs);
        if (!report) continue;
        const cardId = mapRunNodeId(nodeId);
        pushLog("info", describeDeviceReport(report), cardId);
        patchNode(cardId, { deviceReport: report });
      }
    },
    [pushLog, mapRunNodeId, patchNode],
  );

  // Surface output paths onto result-bearing cards. The thumbnail itself is
  // fetched lazily by the node when it scrolls into view (see HgripeNode).
  const applyPreviews = useCallback(
    (graph: ReturnType<typeof toWorkflowGraph>, result: { outputs: Map<string, Record<string, unknown>> }) => {
      const paths: string[] = [];
      const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
      for (const node of graph.nodes) {
        // Lowered row nodes have no visible card of their own kind to patch.
        if (loweredOrigin.current.has(node.id)) continue;
        const out = result.outputs.get(node.id);
        if (node.kind === "crop") {
          // Surface the result image onto the card so confirming an edit (or a
          // run-up-to-node) shows the cropped result immediately.
          const imagePath = str(out?.image);
          patchNode(node.id, { imagePath });
          if (imagePath) paths.push(imagePath);
        } else if (node.kind === "smartLayerSplit") {
          // Surface the run's real layered asset onto the card so the review
          // panel replaces its client-side stub with segmented layers.
          patchNode(node.id, { layeredAsset: parseLayeredImageAsset(out?.layered_asset) });
        } else if (node.kind === "psdExport") {
          // Surface the export triplet onto the card. Browser executors return
          // camelCase; the Rust backend returns the raw snake_case fields.
          const psdPath = str(out?.psdPath) ?? str(out?.psd_path);
          const psdPreviewPath = str(out?.previewPath) ?? str(out?.preview_path);
          const psdMetadataPath = str(out?.metadataPath) ?? str(out?.metadata_path);
          patchNode(node.id, {
            psdPath,
            psdPreviewPath,
            psdMetadataPath,
            placeholderKind: str(out?.placeholderKind) ?? str(out?.placeholder_kind),
            smartObjectMode: str(out?.smartObjectMode) ?? str(out?.smart_object_mode),
          });
          if (psdPreviewPath) paths.push(psdPreviewPath);
        }
      }
      return paths;
    },
    [patchNode],
  );

  // Surface PSD-chain problems (missing template path / unconnected inputs) in
  // the run log before executing, so users do not have to wait for a mid-run
  // failure to find them.
  const warnPsdChain = useCallback(
    async (graph: WorkflowGraph, scope?: RunScope) => {
      for (const w of validatePsdChain(graph)) pushLog("warn", `⚠ ${w.node}: ${w.message}`);
      // Backend selection contract, step 8: a stored api_profile_ref /
      // local_model_ref must exist in the manager and declare the capability
      // its selector filters by. Warnings only — executors keep their own
      // fallback behavior. Row-scoped runs check only the running row's
      // bindings — the other rows of the card do not execute.
      const rowFilter =
        scope?.kind === "card_row" ? { nodeId: scope.nodeId, rowId: scope.rowId } : undefined;
      for (const w of validateBackendRefs(graph, loadRegistry(), { rowFilter }))
        pushLog("warn", `⚠ ${w.node}: ${w.message}`);
      // Beyond the syntactic checks above, confirm against the real files on
      // disk. This needs the Python/psd-tools backend, so it is desktop-only;
      // browser preview keeps just the path-shape check.
      if (!isTauri()) return;
      for (const tpl of psdTemplatePaths(graph)) {
        try {
          const info = await inspectPsd(tpl.path);
          if (info && !info.exists) {
            pushLog("warn", `⚠ ${tpl.node}: PSD Template: file not found on disk (${tpl.path})`);
          }
        } catch (err) {
          pushLog("warn", `⚠ ${tpl.node}: PSD Template: could not inspect (${String(err)})`);
        }
      }
      for (const tgt of psdExportTargets(graph)) {
        if (!tgt.placeholder || !tgt.templatePath) continue;
        try {
          const info = await inspectPsd(tgt.templatePath, [tgt.placeholder]);
          if (info && info.exists && info.missing.includes(tgt.placeholder)) {
            const available = info.layers
              .map((l) => l.name)
              .filter(Boolean)
              .slice(0, 12)
              .join(", ");
            pushLog(
              "warn",
              `⚠ ${tgt.node}: PSD Export: placeholder layer "${tgt.placeholder}" not found in PSD${available ? ` (available: ${available})` : ""}`,
            );
          }
        } catch (err) {
          pushLog("warn", `⚠ ${tgt.node}: PSD Export: could not inspect template (${String(err)})`);
        }
      }
    },
    [pushLog],
  );

  // Shared scoped-run executor: every manual run entry point produces a
  // RunScope, resolves it into the subgraph to execute, and goes through this
  // single pipeline (PSD/backend-ref warnings, lowering, backend dispatch,
  // previews, history). Row/card/selection affordances plug in here by
  // constructing new scopes rather than new run loops.
  const runScope = useCallback(async (scope: RunScope) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setShowLog(true);
    runFailures.current = [];
    autoSnapshotBeforeRun();
    const useRustBackend = isTauri();
    const backend = useRustBackend ? "Rust backend" : "browser preview";
    const scopeLabel = describeRunScope(scope);
    setMessage(useRustBackend ? "running Rust backend…" : "running browser preview…");
    clearRunInfo();
    const startedAt = Date.now();
    runEntriesRef.current = [];
    let outcome: RunOutcome = "succeeded";
    pushLog("info", `▶ run started: ${scopeLabel} (${backend})`);
    try {
      const full = toWorkflowGraph(nodes, edges);
      const resolved = resolveRunScope(full, scope);
      for (const warning of resolved.warnings) pushLog("warn", `⚠ ${warning}`);
      const authored = resolved.graph;
      await warnPsdChain(authored, scope);
      const { graph, origin } = lowerWorkflowGraph(authored);
      loweredOrigin.current = origin;
      for (const line of buildRunReport({ scopeLabel, authored, lowered: graph, origin }))
        pushLog("info", line);
      if (useRustBackend) {
        const runId = beginRustRun();
        try {
          const result = await runStudioGraph(graph, applyStudioRunEvent, runId);
          applyStudioRunResult(result);
          const outputs = studioOutputsToMap(result);
          logDeviceReports(outputs);
          applyPreviews(graph, { outputs });
          setMessage("done (Rust backend)");
        } finally {
          endRustRun(runId);
        }
      } else {
        const token = { cancelled: false };
        browserCancel.current = token;
        try {
          const result = await runGraph(
            graph,
            defaultExecutors,
            observer,
            undefined,
            () => token.cancelled,
          );
          logDeviceReports(result.outputs);
          applyPreviews(graph, result);
          setMessage("done (browser preview)");
        } finally {
          browserCancel.current = null;
        }
      }
      pushLog("success", `✔ run finished: ${scopeLabel} (${backend})`);
    } catch (err) {
      const message = String(err);
      const cancelled = message.toLowerCase().includes("cancel");
      outcome = cancelled ? "cancelled" : "failed";
      setMessage(cancelled ? "cancelled" : `error: ${message}`);
      pushLog(cancelled ? "warn" : "error", cancelled ? "run cancelled" : `run failed: ${message}`);
    } finally {
      setRunning(false);
      inFlight.current = false;
      browserCancel.current = null;
      highlightFailures();
      recordRunHistory("run", startedAt, outcome, backend);
    }
  }, [
    nodes,
    edges,
    observer,
    clearRunInfo,
    logDeviceReports,
    applyPreviews,
    applyStudioRunResult,
    applyStudioRunEvent,
    beginRustRun,
    endRustRun,
    pushLog,
    autoSnapshotBeforeRun,
    highlightFailures,
    warnPsdChain,
    recordRunHistory,
    setMessage,
  ]);

  // The controller always operates on the active canvas's live graph, so the
  // scope's canvasId is a fixed marker rather than a lookup key here.
  const run = useCallback(
    () => runScope({ kind: "full_canvas", canvasId: ACTIVE_CANVAS }),
    [runScope],
  );

  // Run only the target node + its transitive inputs (ancestor subgraph), so
  // confirming an edit surfaces that node's result without executing unrelated
  // downstream branches.
  const runUpToNode = useCallback(
    (nodeId: string) => runScope({ kind: "node_upstream", canvasId: ACTIVE_CANVAS, nodeId }),
    [runScope],
  );

  const runCardRow = useCallback(
    (nodeId: string, rowId: string) =>
      runScope({ kind: "card_row", canvasId: ACTIVE_CANVAS, nodeId, rowId }),
    [runScope],
  );

  const runCard = useCallback(
    (nodeId: string) => runScope({ kind: "card", canvasId: ACTIVE_CANVAS, nodeId }),
    [runScope],
  );

  const runSelection = useCallback(
    (nodeIds: string[]) =>
      runScope({ kind: "selection_with_upstream", canvasId: ACTIVE_CANVAS, nodeIds }),
    [runScope],
  );

  const runSelectionOnly = useCallback(
    (nodeIds: string[]) =>
      runScope({ kind: "selection_only", canvasId: ACTIVE_CANVAS, nodeIds }),
    [runScope],
  );

  // Downstream never runs implicitly (it may hold API generation / export /
  // expensive inference) — this is the explicit "Run downstream" entry point.
  const runNodeDownstream = useCallback(
    (nodeId: string) => runScope({ kind: "node_downstream", canvasId: ACTIVE_CANVAS, nodeId }),
    [runScope],
  );

  // Batch fan-out: run the graph once per item of the (first) batch node,
  // sweeping its `index`. In Tauri, the graph is copied with an index override
  // and sent to Rust; in browser preview, runGraph uses paramOverrides.
  const batchNode = useMemo(
    () => nodes.find((n) => (n.data as HgripeNodeData).kind === "batch") ?? null,
    [nodes],
  );
  const batchCount = useMemo(
    () => (batchNode ? batchItems((batchNode.data as HgripeNodeData).params.items).length : 0),
    [batchNode],
  );

  const runBatch = useCallback(async () => {
    if (!batchNode || batchCount === 0) {
      setMessage("batch: no items");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setShowLog(true);
    runFailures.current = [];
    autoSnapshotBeforeRun();
    clearRunInfo();
    const useRustBackend = isTauri();
    const backend = useRustBackend ? "Rust backend" : "browser preview";
    const rustRunId = useRustBackend ? beginRustRun() : null;
    const startedAt = Date.now();
    runEntriesRef.current = [];
    let outcome: RunOutcome = "succeeded";
    pushLog("info", `▶ batch started: ${batchCount} run(s) (${backend})`);
    const browserToken = useRustBackend ? null : { cancelled: false };
    if (browserToken) browserCancel.current = browserToken;
    try {
      const authored = toWorkflowGraph(nodes, edges);
      await warnPsdChain(authored);
      const { graph, origin } = lowerWorkflowGraph(authored);
      loweredOrigin.current = origin;
      const collected: string[] = [];
      for (let i = 0; i < batchCount; i++) {
        if (browserToken?.cancelled) throw new Error("batch cancelled");
        setMessage(
          `batch ${i + 1}/${batchCount}${useRustBackend ? " (Rust backend)" : " (browser preview)"}…`,
        );
        pushLog("info", `— batch item ${i + 1}/${batchCount}`);
        if (useRustBackend) {
          const graphForRun = graphWithParamOverrides(graph, batchNode.id, { index: i });
          const result = await runStudioGraph(graphForRun, applyStudioRunEvent, rustRunId ?? undefined);
          applyStudioRunResult(result);
          collected.push(...applyPreviews(graphForRun, { outputs: studioOutputsToMap(result) }));
        } else {
          const overrides = new Map([[batchNode.id, { index: i }]]);
          const result = await runGraph(
            graph,
            defaultExecutors,
            observer,
            overrides,
            () => browserToken?.cancelled ?? false,
          );
          collected.push(...applyPreviews(graph, result));
        }
      }
      setMessage(
        `batch done: ${batchCount} run(s), ${collected.length} output(s)${
          useRustBackend ? " via Rust backend" : ""
        }`,
      );
      pushLog("success", `✔ batch finished: ${batchCount} run(s), ${collected.length} output(s)`);
    } catch (err) {
      const message = String(err);
      const cancelled = message.toLowerCase().includes("cancel");
      outcome = cancelled ? "cancelled" : "failed";
      setMessage(cancelled ? "batch cancelled" : `batch error: ${message}`);
      pushLog(cancelled ? "warn" : "error", cancelled ? "batch cancelled" : `batch failed: ${message}`);
    } finally {
      if (rustRunId) endRustRun(rustRunId);
      setRunning(false);
      inFlight.current = false;
      browserCancel.current = null;
      highlightFailures();
      recordRunHistory("batch", startedAt, outcome, backend);
    }
  }, [
    batchNode,
    batchCount,
    nodes,
    edges,
    observer,
    clearRunInfo,
    applyPreviews,
    applyStudioRunResult,
    applyStudioRunEvent,
    beginRustRun,
    endRustRun,
    pushLog,
    autoSnapshotBeforeRun,
    highlightFailures,
    warnPsdChain,
    recordRunHistory,
    setMessage,
  ]);

  // Project-level batch (multi-canvas plan Phase 5): run every open canvas's
  // graph sequentially. Only the active canvas has visible cards, so only its
  // statuses/previews are applied back; parked canvases run headlessly and
  // report through the run log.
  const runProject = useCallback(
    async (canvases: ProjectRunCanvas[]) => {
      const runnable = canvases.filter((c) => c.graph.nodes.length > 0);
      if (runnable.length === 0) {
        setMessage("project run: no canvases with nodes");
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      setRunning(true);
      setShowLog(true);
      runFailures.current = [];
      autoSnapshotBeforeRun();
      clearRunInfo();
      const useRustBackend = isTauri();
      const backend = useRustBackend ? "Rust backend" : "browser preview";
      const rustRunId = useRustBackend ? beginRustRun() : null;
      const startedAt = Date.now();
      runEntriesRef.current = [];
      let outcome: RunOutcome = "succeeded";
      pushLog("info", `▶ project run started: ${runnable.length} canvas(es) (${backend})`);
      const browserToken = useRustBackend ? null : { cancelled: false };
      if (browserToken) browserCancel.current = browserToken;
      // Log-only sinks for parked canvases: their node ids may collide with the
      // active canvas's cards, so nothing is patched back onto the editor.
      const headlessObserver = {
        onStatus: () => {},
        onNodeRun: (id: string, info: NodeRunInfo) => {
          if (info.status === "failed") pushLog("error", describeNodeStatus(info.status, { durationMs: info.durationMs, error: info.error }), id);
        },
      };
      const headlessEvent = (event: StudioGraphRunEvent) => {
        if (event.status === "failed" && event.node_id) {
          pushLog("error", describeNodeStatus("failed", { durationMs: event.duration_ms, error: event.error, detail: event.error_detail }), event.node_id);
        }
      };
      let failedCanvases = 0;
      try {
        for (let i = 0; i < runnable.length; i++) {
          const canvas = runnable[i];
          if (browserToken?.cancelled) throw new Error("project run cancelled");
          setMessage(`project run ${i + 1}/${runnable.length}: ${canvas.title}…`);
          pushLog("info", `— canvas ${i + 1}/${runnable.length}: ${canvas.title}`);
          const failuresBefore = runFailures.current.length;
          try {
            await warnPsdChain(canvas.graph);
            const { graph, origin } = lowerWorkflowGraph(canvas.graph);
            if (canvas.active) loweredOrigin.current = origin;
            if (useRustBackend) {
              const result = await runStudioGraph(
                graph,
                canvas.active ? applyStudioRunEvent : headlessEvent,
                rustRunId ?? undefined,
              );
              if (canvas.active) {
                applyStudioRunResult(result);
                applyPreviews(graph, { outputs: studioOutputsToMap(result) });
              }
              const failed = Object.values(result.statuses).some((s) => toNodeStatus(s) === "failed");
              if (failed) failedCanvases++;
            } else {
              const result = await runGraph(
                graph,
                defaultExecutors,
                canvas.active ? observer : headlessObserver,
                undefined,
                () => browserToken?.cancelled ?? false,
              );
              if (canvas.active) applyPreviews(graph, result);
              if (runFailures.current.length > failuresBefore) failedCanvases++;
            }
            pushLog("success", `✔ canvas finished: ${canvas.title}`);
          } catch (err) {
            const message = String(err);
            if (message.toLowerCase().includes("cancel")) throw err;
            // One broken canvas must not abort the rest of the project run.
            failedCanvases++;
            outcome = "failed";
            pushLog("error", `✖ canvas failed: ${canvas.title}: ${message}`);
          }
        }
        if (failedCanvases > 0) {
          outcome = "failed";
          setMessage(`project run done: ${failedCanvases}/${runnable.length} canvas(es) failed`);
          pushLog("error", `✖ project run finished: ${failedCanvases}/${runnable.length} canvas(es) failed`);
        } else {
          setMessage(`project run done: ${runnable.length} canvas(es) (${backend})`);
          pushLog("success", `✔ project run finished: ${runnable.length} canvas(es)`);
        }
      } catch (err) {
        const message = String(err);
        const cancelled = message.toLowerCase().includes("cancel");
        outcome = cancelled ? "cancelled" : "failed";
        setMessage(cancelled ? "project run cancelled" : `project run error: ${message}`);
        pushLog(cancelled ? "warn" : "error", cancelled ? "project run cancelled" : `project run failed: ${message}`);
      } finally {
        if (rustRunId) endRustRun(rustRunId);
        setRunning(false);
        inFlight.current = false;
        browserCancel.current = null;
        highlightFailures();
        recordRunHistory("project", startedAt, outcome, backend);
      }
    },
    [
      observer,
      clearRunInfo,
      applyPreviews,
      applyStudioRunResult,
      applyStudioRunEvent,
      beginRustRun,
      endRustRun,
      pushLog,
      autoSnapshotBeforeRun,
      highlightFailures,
      warnPsdChain,
      recordRunHistory,
      setMessage,
    ],
  );

  // Run history is a project-scoped store: persisted into the selected project
  // folder on desktop (so it travels with the project), else to localStorage.
  // The shared hook owns the load/persist effects.
  useProjectScopedStore({
    dir: projectStoreDir,
    state: runHistory,
    setState: setRunHistory,
    parse: parseRunHistory,
    read: readStudioRunHistory,
    write: writeStudioRunHistory,
    saveLocal: saveRunHistory,
    label: "run history",
    onError: setMessage,
  });

  const clearLog = useCallback(() => setRunLog([]), []);

  const clearHistory = useCallback(() => {
    setRunHistory((h) => (h.length === 0 || window.confirm("Clear all run history?") ? [] : h));
  }, []);

  return {
    running,
    currentRunId,
    canCancel: running,
    runLog,
    showLog,
    setShowLog,
    clearLog,
    exportLog,
    runHistory,
    showHistory,
    setShowHistory,
    clearHistory,
    run,
    runUpToNode,
    runScope,
    runCardRow,
    runCard,
    runSelection,
    runSelectionOnly,
    runNodeDownstream,
    runBatch,
    runProject,
    cancelRun,
    hasBatch: !!batchNode,
    batchCount,
  };
}
