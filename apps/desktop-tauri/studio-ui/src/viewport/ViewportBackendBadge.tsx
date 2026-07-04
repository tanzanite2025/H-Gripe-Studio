import { useMemo } from "react";
import type { ViewportBackend } from "../bridge/viewport";
import {
  describeDeviceReport,
  deviceReportFromViewportBackend,
} from "../runtime/deviceReport";

// Shared backend badge for viewport-presented surfaces (mask/crop editors,
// media viewer, preview gates): renders the frame's backend through the
// shared DeviceReport vocabulary — the `used` device, a ⚠ marker when the
// frame carries a fallback reason, and the full one-line report as tooltip.
export function ViewportBackendBadge({ backend }: { backend: ViewportBackend | null }) {
  const report = useMemo(
    () => (backend ? deviceReportFromViewportBackend(backend) : null),
    [backend],
  );
  if (!report) return null;
  return (
    <span className="viewport-backend-badge muted" title={describeDeviceReport(report)}>
      {report.used}
      {report.fallbackReason ? " ⚠" : null}
    </span>
  );
}
