import type { PortSpec } from "./model";
import { nodeSpec } from "./nodeSpecs";
import { imageSourceOutputPort } from "../domain/imageSourceSlots";

export function resolveNodePort(
  kind: string,
  params: Record<string, unknown> | null | undefined,
  dir: "in" | "out",
  portId: string | null | undefined,
): PortSpec | undefined {
  const id = portId ?? "";
  if (kind === "imageSource" && dir === "out") {
    const slotPort = imageSourceOutputPort(params, id);
    if (slotPort) return slotPort;
  }
  const spec = nodeSpec(kind);
  const ports = dir === "in" ? spec.inputs : spec.outputs;
  return ports.find((port) => port.id === id);
}
