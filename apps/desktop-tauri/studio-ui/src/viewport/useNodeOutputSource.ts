// Node-output underlay sources (WGPU migration: product-layer target wiring).
// Editors that preview a node's output artifact register it with the viewport
// host and present it as a `node_output` reference target, keeping the
// selection-target model uniform with the drawer and grade surfaces.

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
