import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeSpec, PortSpec } from "../graph/nodeSpecs";
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
  /** Content rendered inside an input port's block, keyed by port id (e.g. the params belonging to that block). */
  portContent?: Record<string, ReactNode>;
  children?: ReactNode;
}

export function NodeCardShell({
  spec,
  selected,
  status,
  lod,
  durationMs,
  titleExtra,
  portContent,
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
      {spec.inputs.length + spec.outputs.length > 0 && (
        <div className="node-ports">
          {spec.inputs.map((p) => (
            <PortBlock key={`in-${p.id}`} port={p} side="in">
              {portContent?.[p.id]}
            </PortBlock>
          ))}
          {spec.outputs.map((p) => (
            <PortBlock key={`out-${p.id}`} port={p} side="out" />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

// One framed function block per port, tinted by the port's data type; the
// connection dot uses the same colour and stays vertically centred on the
// block, however tall the block grows (labels, inline params, …). This keeps
// dots semantically aligned with their block instead of auto-spaced by total
// port count (see NODE_CARD_PRODUCT_BOUNDARY_PLAN.md, Image Processing Card).
function PortBlock({
  port,
  side,
  children,
}: {
  port: PortSpec;
  side: "in" | "out";
  children?: ReactNode;
}) {
  return (
    <div className={`port-block port-block-${side} port-type-${port.type}`}>
      <Handle
        id={port.id}
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        className={`port port-${port.type}`}
        title={`${port.label}: ${port.type}`}
      />
      <span className="port-label">{port.label}</span>
      {children}
    </div>
  );
}
