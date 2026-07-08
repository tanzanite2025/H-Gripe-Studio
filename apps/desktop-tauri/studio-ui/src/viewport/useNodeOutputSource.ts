// Node-output underlay sources (WGPU migration: preview/review target wiring).
// This hook is for preview gates that intentionally present a node artifact by
// reference. Software-level editors must display their concrete asset path and
// treat node ids only as opening/commit context.

import { useEffect, useState } from "react";
import { registerNodeOutput } from "../bridge/viewport";
import type { ViewportUnderlaySource } from "./useViewportUnderlay";

/**
 * Register `path` as `nodeId`'s output artifact and return a `node_output`
 * underlay source once registration lands (a re-registration after a re-run
 * replaces the artifact path). While pending, after a failure, or when no
 * node id is given, the plain path is the source — the same underlay renders
 * either way, only the reference model differs.
 */
export function useNodeOutputSource(
  nodeId: string | null | undefined,
  path: string | null | undefined,
): ViewportUnderlaySource | undefined {
  const [registered, setRegistered] = useState<string | null>(null);
  useEffect(() => {
    setRegistered(null);
    if (!nodeId || !path) return;
    let cancelled = false;
    registerNodeOutput(nodeId, path)
      .then(() => {
        if (!cancelled) setRegistered(nodeId);
      })
      .catch(() => {
        /* keep the path source */
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, path]);

  if (!path) return undefined;
  return nodeId && registered === nodeId ? { kind: "node_output", nodeId } : path;
}
