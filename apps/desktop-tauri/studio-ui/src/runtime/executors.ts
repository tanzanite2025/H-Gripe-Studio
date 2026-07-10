// Default browser-preview executor registry, assembled by execution domain.

import type { ExecutorRegistry } from "./dag";
import { API_EXECUTORS } from "./executors/api";
import { GRAPH_EXECUTORS } from "./executors/graph";
import { IMAGE_EXECUTORS } from "./executors/image";
import { VIDEO_EXECUTORS } from "./executors/video";

export { batchItems } from "./executors/graph";

function combineExecutorRegistries(...groups: ExecutorRegistry[]): ExecutorRegistry {
  const registry: ExecutorRegistry = {};
  for (const group of groups) {
    for (const [kind, executor] of Object.entries(group)) {
      if (kind in registry) throw new Error(`duplicate node executor: ${kind}`);
      registry[kind] = executor;
    }
  }
  return registry;
}

export const defaultExecutors = combineExecutorRegistries(
  GRAPH_EXECUTORS,
  API_EXECUTORS,
  IMAGE_EXECUTORS,
  VIDEO_EXECUTORS,
);
