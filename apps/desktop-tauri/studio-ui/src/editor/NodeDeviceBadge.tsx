import { describeDeviceReport, type DeviceReport } from "../runtime/deviceReport";

// Per-node device transparency badge (GPU_DEVICE_STRATEGY_PLAN step 5): the
// card header and Inspector render the node's last-run DeviceReport — the
// `used` device, a visible ⚠ marker on fallback, and the full one-line
// report as tooltip. Same rendering rules as the viewport backend badge.
export function NodeDeviceBadge({ report }: { report?: DeviceReport | null }) {
  if (!report) return null;
  return (
    <span className="node-device-badge muted" title={describeDeviceReport(report)}>
      {report.used}
      {report.fallbackReason ? " ⚠" : null}
    </span>
  );
}
