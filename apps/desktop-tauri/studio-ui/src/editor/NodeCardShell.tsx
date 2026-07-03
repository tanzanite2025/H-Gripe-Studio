import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeSpec } from "../graph/nodeSpecs";
import type { NodeStatus } from "../runtime/dag";
import { NodeTypeBadge } from "./NodeTypeBadge";
import { fmtDuration } from "./HgripeNode";

// The one node-card frame every node kind renders through: outer card,
// corner type badge, title row, status badge, and the input/output handles.
// Individual node kinds only differ by their spec (family → badge icon,
// ports → handles) and the body content passed as children.
export interface NodeCardShellProps {
  spec: NodeSpec;
  selected: boolean;
  status: NodeStatus;
  lod: boolean;
  durationMs?: number;
  /** Extra element rendered inside the title row (e.g. the PSD tag). */
  titleExtra?: ReactNode;
  children?: ReactNode;
}

export function NodeCardShell({
  spec,
  selected,
  status,
  lod,
  durationMs,
  titleExtra,
  children,
}: NodeCardShellProps) {
  return (
    <div className={`node ${selected ? "selected" : ""} status-${status} ${lod ? "lod" : ""}`}>
      <NodeTypeBadge family={spec.family} />
      <div className="node-header">
        <span className="node-title">{spec.title}</span>
        {titleExtra}
        <span className={`badge badge-${status}`} title={fmtDuration(durationMs)}>
          {status}
          {durationMs != null && (status === "succeeded" || status === "failed" || status === "cancelled") ? (
            <em className="badge-time"> {fmtDuration(durationMs)}</em>
          ) : null}
        </span>
      </div>
      {children}
      {spec.inputs.map((p, i) => (
        <Handle
          key={`in-${p.id}`}
          id={p.id}
          type="target"
          position={Position.Left}
          className={`port port-${p.type}`}
          style={{ top: 44 + i * 22 }}
          title={`${p.label}: ${p.type}`}
        />
      ))}
      {spec.outputs.map((p, i) => (
        <Handle
          key={`out-${p.id}`}
          id={p.id}
          type="source"
          position={Position.Right}
          className={`port port-${p.type}`}
          style={{ top: 44 + i * 22 }}
          title={`${p.label}: ${p.type}`}
        />
      ))}
    </div>
  );
}
