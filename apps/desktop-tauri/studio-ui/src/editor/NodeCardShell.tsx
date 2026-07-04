import type { CSSProperties, ReactNode, Ref } from "react";
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
  /** Opens the on-demand right-side Inspector for this node. */
  onOpenInspector?: () => void;
  /** Content rendered inside an input port's block, keyed by port id (e.g. the params belonging to that block). */
  portContent?: Record<string, ReactNode>;
  /** When set, paired semantic rows show a run button that runs just that row. */
  onRunRow?: (rowId: string) => void;
  /** Tooltip for the per-row run button. */
  runRowTitle?: string;
  /** When set, the header shows a run button that runs this card + upstream. */
  onRunCard?: () => void;
  /** Tooltip for the card-level run button. */
  runCardTitle?: string;
  /** Ref to the card's root element (e.g. to measure its expanded height). */
  rootRef?: Ref<HTMLDivElement>;
  /** Inline style on the card root (e.g. a preserved min-height under LOD). */
  style?: CSSProperties;
  children?: ReactNode;
}

export function NodeCardShell({
  spec,
  selected,
  status,
  lod,
  durationMs,
  titleExtra,
  onOpenInspector,
  portContent,
  onRunRow,
  runRowTitle,
  onRunCard,
  runCardTitle,
  rootRef,
  style,
  children,
}: NodeCardShellProps) {
  return (
    <div
      ref={rootRef}
      style={style}
      className={`node ${selected ? "selected" : ""} status-${status} ${lod ? "lod" : ""}`}
    >
      <NodeTypeBadge family={spec.family} />
      <div className="node-header">
        <span className="node-title">{spec.title}</span>
        {titleExtra}
        <span className="node-header-actions">
          {onRunCard && (
            <button
              type="button"
              className="node-run-card-btn nodrag nowheel"
              title={runCardTitle}
              aria-label={runCardTitle}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRunCard();
              }}
            >
              ▶
            </button>
          )}
          <span
            className={`node-status-dot node-status-${status}`}
            title={durationMs != null ? `${status} ${fmtDuration(durationMs)}` : status}
            aria-label={`status ${status}`}
          />
          {onOpenInspector && (
            <button
              type="button"
              className="node-inspector-btn nodrag nowheel"
              title="Edit node settings"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenInspector();
              }}
            >
              ⚙
            </button>
          )}
        </span>
      </div>
      {spec.inputs.length + spec.outputs.length > 0 && (
        <div className="node-ports">
          {groupPortRows(spec).map((row) =>
            row.paired ? (
              <PairedPortRow
                key={`row-${row.key}`}
                row={row}
                portContent={portContent}
                onRun={onRunRow ? () => onRunRow(row.key) : undefined}
                runTitle={runRowTitle}
              />
            ) : row.inputs.length > 0 ? (
              <PortBlock key={`in-${row.key}`} port={row.inputs[0]} side="in">
                {portContent?.[row.inputs[0].id]}
              </PortBlock>
            ) : (
              <PortBlock key={`out-${row.key}`} port={row.outputs[0]} side="out" />
            ),
          )}
        </div>
      )}
      {children}
    </div>
  );
}

interface PortRowGroup {
  key: string;
  paired: boolean;
  inputs: PortSpec[];
  outputs: PortSpec[];
}

// Ports whose ids share a `row.` prefix (e.g. `grade.in` / `grade.out`) form
// one semantic row with its inputs on the left and outputs on the right, so
// both dots sit on the same visible row. Ports without a prefix keep their
// own single block. Rows keep the order of first appearance (inputs, then
// remaining output-only rows).
export function groupPortRows(spec: NodeSpec): PortRowGroup[] {
  const rows: PortRowGroup[] = [];
  const byKey = new Map<string, PortRowGroup>();
  const add = (port: PortSpec, side: "in" | "out") => {
    const dot = port.id.indexOf(".");
    if (dot <= 0) {
      rows.push({
        key: `${side}:${port.id}`,
        paired: false,
        inputs: side === "in" ? [port] : [],
        outputs: side === "out" ? [port] : [],
      });
      return;
    }
    const key = port.id.slice(0, dot);
    let row = byKey.get(key);
    if (!row) {
      row = { key, paired: true, inputs: [], outputs: [] };
      byKey.set(key, row);
      rows.push(row);
    }
    (side === "in" ? row.inputs : row.outputs).push(port);
  };
  for (const p of spec.inputs) add(p, "in");
  for (const p of spec.outputs) add(p, "out");
  return rows;
}

// A semantic row block: input dots on the left edge, output dots on the
// right, all vertically centred on their own entry line within the row.
function PairedPortRow({
  row,
  portContent,
  onRun,
  runTitle,
}: {
  row: PortRowGroup;
  portContent?: Record<string, ReactNode>;
  onRun?: () => void;
  runTitle?: string;
}) {
  const type = (row.inputs[0] ?? row.outputs[0]).type;
  return (
    <div className={`port-block port-block-pair port-type-${type}`}>
      {onRun && (
        <button
          type="button"
          className="port-row-run nodrag nowheel"
          title={runTitle}
          aria-label={runTitle}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          ▶
        </button>
      )}
      <div className="port-side port-side-in">
        {row.inputs.map((p) => (
          <div key={p.id} className="port-entry">
            <Handle
              id={p.id}
              type="target"
              position={Position.Left}
              className={`port port-${p.type}`}
              title={`${p.label}: ${p.type}`}
            />
            <span className="port-label">{p.label}</span>
            {portContent?.[p.id]}
          </div>
        ))}
      </div>
      <div className="port-side port-side-out">
        {row.outputs.map((p) => (
          <div key={p.id} className="port-entry port-entry-out">
            <span className="port-label">{p.label}</span>
            <Handle
              id={p.id}
              type="source"
              position={Position.Right}
              className={`port port-${p.type}`}
              title={`${p.label}: ${p.type}`}
            />
          </div>
        ))}
      </div>
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
