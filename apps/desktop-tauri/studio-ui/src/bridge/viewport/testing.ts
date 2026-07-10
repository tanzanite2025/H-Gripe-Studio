import { setViewportClientForTesting } from "./client";
import { createMockViewportClient, type MockViewportClient } from "./mock";

export function installMockViewportClient(): MockViewportClient {
  const client = createMockViewportClient();
  setViewportClientForTesting(client);
  return client;
}

export function resetViewportClient(): void {
  setViewportClientForTesting(null);
}
