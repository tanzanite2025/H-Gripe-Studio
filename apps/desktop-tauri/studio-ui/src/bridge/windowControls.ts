import { tauriInvoke } from "./core";

async function invokeWindow(command: string): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke(command);
}

export function minimizeWindow(): Promise<void> {
  return invokeWindow("window_minimize");
}

export function toggleMaximizeWindow(): Promise<void> {
  return invokeWindow("window_toggle_maximize");
}

export function closeWindow(): Promise<void> {
  return invokeWindow("window_close");
}
