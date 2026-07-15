import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Handle, Position, useStore, type NodeProps } from "@hgripe/flow";
import { nodeSpec } from "../graph/nodeSpecs";
import { localizeSpec } from "../graph/nodeSpecsI18n";
import { LangContext, useT } from "../i18n";
import { lodLevel } from "./lod";
import { connectedInputPorts } from "./connectedPorts";
import type { NodeStatus } from "../runtime/dag";
import {
  generateThumbnail,
  pickFile,
  probeImageDims,
  primeIngest,
  registerResource,
  resourceThumbnail,
  videoProbe,
} from "../bridge/tauri";
import { subscribeIngest } from "../runtime/ingestStore";
import { whenGpuIdle } from "../runtime/gpuLoad";
import { ParamField } from "./ParamField";
import { useNodeEditing } from "./editingContext";
import { psdTemplatePathWarning } from "./psdcheck";
import { NodeCardShell } from "./NodeCardShell";
import { LOWERED_CARD_ROWS } from "../graph/lowering";
import type { LayeredImageAsset } from "../domain/layeredImage";
import { IMAGE_MEDIA_EXTS } from "../domain/mediaFormats";
import type { DeviceReport } from "../runtime/deviceReport";
import {
  imageSourceSlotPortId,
  MAX_IMAGE_SOURCE_SLOTS,
  normalizeImageSourceSlots,
  type ImageSourceSlot,
} from "../domain/imageSourceSlots";
import {
  IMAGE_SOURCE_THUMB_MODE,
  IMAGE_SOURCE_THUMB_SIZE,
  imageSourceCardWidthForSlots,
} from "./nodeGeometry";

export interface HgripeNodeData extends Record<string, unknown> {
  kind: string;
  params: Record<string, unknown>;
  status?: NodeStatus;
  /** Last run's wall-clock duration in ms (executed nodes only). */
  durationMs?: number;
  /** Last run's error message, when `status === "failed"` / `cancelled`. */
  error?: string | null;
  /** Path of the most recent output image, if any. */
  imagePath?: string | null;
  /** Backend-generated thumbnail data URL / path for display. */
  thumbnail?: string | null;
  /** PSD Export results from the last run (psdExport node only). */
  psdPath?: string | null;
  psdPreviewPath?: string | null;
  psdMetadataPath?: string | null;
  /** Resolved placeholder kind / smart-object mode reported by the backend. */
  placeholderKind?: string | null;
  smartObjectMode?: string | null;
  /** Subject Mask outputs from the last run (subjectMask node only). */
  maskPath?: string | null;
  alphaImagePath?: string | null;
  cutoutImagePath?: string | null;
  /** Layered image asset from the last run (smartLayerSplit node only). */
  layeredAsset?: LayeredImageAsset | null;
  /** Last run's device report (shared DeviceReport vocabulary), if any. */
  deviceReport?: DeviceReport | null;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

// Compact human-readable run time, e.g. "12ms" / "1.4s".
export function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

// Thumbnail tile that only asks the backend for a thumbnail once the node
// actually scrolls into view (IntersectionObserver). This keeps the graph data
// light (it stores only the original path) and avoids decoding images for nodes
// parked off-screen 鈥?the real perf/quality discipline for large media.
function LazyThumb({ path }: { path: string }) {
  const t = useT();
  const editing = useNodeEditing();
  const ref = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        // Thumbnails are cosmetic: wait out any in-flight GPU-heavy work (a
        // graph run) before asking the backend to decode.
        whenGpuIdle()
          .then(() => (cancelled ? null : generateThumbnail({ path, size: 256 })))
          .then((thumb) => {
            if (thumb && !cancelled) setSrc(thumb.data_url || null);
          })
          .catch(() => {
            /* leave placeholder on failure */
          });
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [path]);

  return (
    <div ref={ref} className="node-thumb-wrap">
      {src ? (
        <img
          className="node-thumb"
          src={src}
          alt="preview"
          title={t("node.thumbPreviewTitle")}
          onDoubleClick={() => editing?.openImagePreview?.(path)}
        />
      ) : (
        <div className="node-thumb placeholder">{t("common.loadingShort")}</div>
      )}
    </div>
  );
}

// Generic image media card body: a thumbnail + `name 路 W脳H` info row + an
// action row whose buttons spawn a *bound* edit node (the source card is never
// mutated). Ingestion is two-phase and pushed from the backend: on a drop the
// `prime_ingest` pipeline probes header dims (info row renders `W脳H` at once,
// even for a 4K/8K source) then decodes the thumbnail off-thread, both arriving
// over `ingest://progress`. A header probe + IntersectionObserver-gated
// thumbnail fetch remain as fallbacks for cards not created by a drop (manual
// path entry, project load) or a missed event. See docs/cards/generic-media-card.md.
function ImageSourceTile({ nodeId, slot }: { nodeId: string; slot: ImageSourceSlot }) {
  const t = useT();
  const editing = useNodeEditing();
  const ref = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Set once a thumbnail arrives (pushed or fetched) so the lazy fallback does
  // not re-fetch what the backend already delivered.
  const haveThumb = useRef(false);
  // Lightweight backend handle for this path; the card fetches its thumbnail by
  // id so the heavy pixels stay in Rust. Read from a ref inside the observer so
  // resolving it does not re-run (and reset) the observer effect.
  const resourceId = useRef<string | null>(null);
  const path = slot.path;

  // Fast path: consume dims/thumbnail pushed by the backend ingestion pipeline.
  useEffect(() => {
    if (!path) return;
    return subscribeIngest(
      path,
      (state) => {
        if (state.dims) setDims(state.dims);
        if (state.thumb) {
          haveThumb.current = true;
          setSrc(state.thumb);
        }
      },
      IMAGE_SOURCE_THUMB_MODE,
    );
  }, [path]);

  // Resolve the lightweight ResourceId handle for this path. Registration also
  // returns header dims, so the info row renders `W脳H` from the same round-trip
  // (no separate probe needed on the fast path).
  useEffect(() => {
    setDims(null);
    resourceId.current = null;
    if (!path) return;
    let cancelled = false;
    registerResource(path)
      .then((res) => {
        if (cancelled || !res) return;
        resourceId.current = res.id;
        if (res.width && res.height) {
          setDims((cur) => cur ?? { w: res.width!, h: res.height! });
        }
      })
      .catch(() => {
        /* fall back to the header probe below */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Fallback: probe dimensions from the file header for the info row when the
  // resource registry is unavailable (e.g. browser preview) or returned none.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    probeImageDims(path)
      .then((d) => {
        if (!cancelled && d && d.width && d.height) {
          setDims((cur) => cur ?? { w: d.width, h: d.height });
        }
      })
      .catch(() => {
        /* fall back to the dimensions the thumbnail reports */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Decode the thumbnail once the card scrolls into view, unless a pushed
  // thumbnail already arrived. Fetch by ResourceId when resolved (path only as
  // a fallback); a warm cache makes either instant.
  useEffect(() => {
    setSrc(null);
    haveThumb.current = false;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        if (haveThumb.current) return;
        const id = resourceId.current;
        const req = id
          ? resourceThumbnail(id, IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE)
          : generateThumbnail({
              path,
              size: IMAGE_SOURCE_THUMB_SIZE,
              mode: IMAGE_SOURCE_THUMB_MODE,
            });
        req
          .then((thumb) => {
            if (cancelled || haveThumb.current || !thumb) return;
            haveThumb.current = true;
            setSrc(thumb.data_url || null);
            // Fallback only: keep dims if register/probe already set them.
            if (thumb.width && thumb.height) {
              setDims((cur) => cur ?? { w: thumb.width, h: thumb.height });
            }
          })
          .catch(() => {
            /* leave placeholder on failure */
          });
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [path]);

  return (
    <div
      ref={ref}
      className="image-source-tile"
      style={{ "--slot-color": slot.color } as CSSProperties}
    >
      <div className="image-source-slot-head">
        <span className="image-source-slot-badge">{slot.label}</span>
        <span className="image-source-slot-role" title={slot.role}>
          {slot.role}
        </span>
      </div>
      <div
        className="image-source-preview-well"
        title={t("node.thumbPreviewTitle")}
        onDoubleClick={() => editing?.openImagePreview?.(path)}
      >
        {src ? (
          <img className="image-source-thumb" src={src} alt="preview" />
        ) : (
          <div className="image-source-placeholder">{t("common.loadingShort")}</div>
        )}
      </div>
      <div className="media-info">
        <span className="media-name" title={path}>
          {basename(path)}
        </span>
        {dims ? (
          <span className="media-dims">
            {dims.w}脳{dims.h}
          </span>
        ) : null}
      </div>
      <Handle
        id={imageSourceSlotPortId(slot.id)}
        type="source"
        position={Position.Bottom}
        className="port image-source-slot-port"
        title={`${slot.label}: image`}
      />
      <div className="media-card-actions nodrag">
        <button
          type="button"
          className="primary"
          title={t("node.importImageEditorTitle")}
          onClick={() => editing?.openImageSourceEditor?.(nodeId)}
        >
          {t("node.importImageEditor")}
        </button>
      </div>
    </div>
  );
}

const IMAGE_PICKER_EXTENSIONS = [...IMAGE_MEDIA_EXTS];

function ImageSourceAddTile({ nodeId }: { nodeId: string }) {
  const t = useT();
  const editing = useNodeEditing();
  const pick = async () => {
    const path = await pickFile({
      title: t("imageEdit.pickTitle"),
      filterName: "Images",
      extensions: IMAGE_PICKER_EXTENSIONS,
    });
    if (!path) return;
    editing?.appendImageSourcePaths?.(nodeId, [path]);
    void primeIngest([path], IMAGE_SOURCE_THUMB_SIZE, undefined, IMAGE_SOURCE_THUMB_MODE);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void pick();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className="image-source-add-tile nodrag"
      data-image-source-node-id={nodeId}
      title={t("node.imageSourceAddTitle")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => void pick()}
      onKeyDown={handleKeyDown}
    >
      <span className="image-source-add-head" aria-hidden="true" />
      <span className="image-source-add-preview" aria-hidden="true">
        <span className="image-source-add-icon">+</span>
      </span>
      <span className="image-source-add-label">{t("node.imageSourceAdd")}</span>
      <span className="image-source-add-action" aria-hidden="true" />
    </div>
  );
}

function ImageSourceCard({ id, slots }: { id: string; slots: ImageSourceSlot[] }) {
  const canAdd = slots.length < MAX_IMAGE_SOURCE_SLOTS;
  return (
    <div className="media-card image-source-card" data-image-source-node-id={id}>
      <div className="image-source-grid">
        {slots.map((slot) => (
          <ImageSourceTile key={slot.id} nodeId={id} slot={slot} />
        ))}
        {canAdd ? <ImageSourceAddTile nodeId={id} /> : null}
      </div>
    </div>
  );
}

// Format a clip length in seconds as `m:ss` (or `h:mm:ss`), e.g. 75 -> "1:15".
function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

// Generic video media card body: a poster frame + `name 路 W脳H 路 m:ss 路 fps` info
// row. Rust has no video decoder, so a backend probe (PyAV) decodes one frame to
// a PNG; the poster is then shown through the same image-thumbnail pipeline. The
// original `path` carries downstream unchanged. See docs/cards/generic-media-card.md.
function VideoSourceCard({ path, posterTimestamp }: { path: string; posterTimestamp: number }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    w: number;
    h: number;
    duration: number | null;
    fps: number | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(null);
    setMeta(null);
    setFailed(false);
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        videoProbe(path, posterTimestamp)
          .then(async (probe) => {
            if (cancelled) return;
            setMeta({ w: probe.width, h: probe.height, duration: probe.duration_sec, fps: probe.fps });
            if (probe.poster_path) {
              const thumb = await generateThumbnail({ path: probe.poster_path, size: 256 });
              if (!cancelled) setSrc(thumb.data_url || null);
            }
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [path, posterTimestamp]);

  return (
    <div ref={ref} className="media-card">
      {src ? (
        <img className="node-thumb" src={src} alt="poster" />
      ) : (
        <div className="node-thumb placeholder">
          {failed ? t("video.probeFailed") : t("common.loadingShort")}
        </div>
      )}
      <div className="media-info">
        <span className="media-name" title={path}>
          {basename(path)}
        </span>
        {meta ? (
          <span className="media-dims">
            {meta.w}脳{meta.h}
            {meta.duration != null ? ` 路 ${formatDuration(meta.duration)}` : ""}
            {meta.fps != null ? ` 路 ${Math.round(meta.fps)}fps` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// A single export-artifact row: label + basename, click to copy the full path.
function PathRow({ label, path }: { label: string; path: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        /* clipboard may be unavailable */
      });
  };
  return (
    <button className="psd-path-row nodrag" onClick={copy} title={t("node.copyHint", { path })}>
      <span className="psd-path-label">{label}</span>
      <span className="psd-path-name">{copied ? t("node.copied") : basename(path)}</span>
    </button>
  );
}

// Custom node is memoized (React Flow perf guidance): node drags must not
// re-render every node. The node shows only a compact summary + a thumbnail;
// full-res media opens in the standalone viewer.
function HgripeNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as HgripeNodeData;
  const lang = useContext(LangContext);
  const t = useT();
  const spec = localizeSpec(nodeSpec(d.kind), lang);
  const status = d.status ?? "idle";
  const editing = useNodeEditing();
  // Card detail drops with zoom: full 鈫?mid (interior hidden) 鈫?collapsed
  // (title-only). A discrete-level selector means nodes only re-render when
  // crossing a threshold, not on every zoom tick.
  const viewportLodTier = useStore((s) => lodLevel(s.transform[2]));
  const fixedLayout = spec.kind === "imageSource";
  const lodTier = fixedLayout ? "full" : viewportLodTier;
  const lod = lodTier === "collapsed";
  const slim = lodTier !== "full";
  // LOD hides the card's body for cheap rendering, but the card must keep its
  // expanded footprint 鈥?a shrunken card reads as "truncated" when zoomed out
  // and shifts the edge/handle geometry. Measure the expanded height (local,
  // pre-zoom coordinates) and pin it as min-height while LOD is active.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const expandedHeight = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!slim && cardRef.current) expandedHeight.current = cardRef.current.offsetHeight;
  });
  // Which input ports of this node currently have an incoming edge 鈥?used to
  // surface "image/template connected" hints on the PSD sink cards.
  const connectedPorts = useStore((s) => connectedInputPorts(s.edges, id));
  const isConnected = (port: string) => connectedPorts.split(",").includes(port);
  // Params flagged `inline` are edited directly on the card.
  // `imageSource`/`psdTemplate` paths get a basename caption so
  // the card stays readable even with a long absolute path.
  const imageSourceSlots =
    spec.kind === "imageSource" ? normalizeImageSourceSlots(d.params) : [];
  const imageSourceVisibleSlotCount =
    spec.kind === "imageSource"
      ? Math.min(
          MAX_IMAGE_SOURCE_SLOTS,
          Math.max(
            1,
            imageSourceSlots.length + (imageSourceSlots.length < MAX_IMAGE_SOURCE_SLOTS ? 1 : 0),
          ),
        )
      : undefined;
  const mediaSourceHasPath =
    spec.kind === "imageSource"
      ? true
      : spec.kind === "videoSource" && Boolean(d.params.path);
  const paramValue = (param: (typeof spec.params)[number]) =>
    d.params[param.key] ?? param.defaultValue;
  const paramIsVisible = (param: (typeof spec.params)[number]) => {
    const condition = param.visibleWhen;
    if (!condition) return true;
    const controller = spec.params.find((candidate) => candidate.key === condition.param);
    const value = controller ? paramValue(controller) : d.params[condition.param];
    return condition.in.includes(String(value ?? ""));
  };
  const inlineParams = spec.params.filter(
    (p) =>
      p.inline &&
      !p.port &&
      paramIsVisible(p) &&
      !(mediaSourceHasPath && p.key === "path"),
  );
  // Inline params bound to an input port render inside that port's function
  // block, keeping the field next to the connection dot that overrides it.
  const blockParams = spec.params.filter((p) => p.inline && p.port && paramIsVisible(p));
  const renderInlineParam = (p: (typeof spec.params)[number]) => (
    <label key={p.key} className={`inline-field inline-field-${p.control}`}>
      <span>{p.label}</span>
      <ParamField
        spec={p}
        value={paramValue(p)}
        onChange={(v) => editing?.onParamChange(id, p.key, v)}
        compact
      />
      {p.control === "path" && d.params[p.key] ? (
        <small className="path">{basename(String(d.params[p.key]))}</small>
      ) : null}
    </label>
  );
  const portContent = blockParams.length
    ? blockParams.reduce<Record<string, ReactNode[]>>((acc, p) => {
        (acc[p.port ?? ""] ??= []).push(renderInlineParam(p));
        return acc;
      }, {})
    : undefined;
  const templateWarn =
    spec.kind === "psdTemplate" ? psdTemplatePathWarning(String(d.params.path ?? "")) : null;
  // Integrated cards (lowered row-by-row) get a per-row run affordance that
  // executes just that row's input chain (RunScope `card_row`), plus a header
  // run button that runs the whole card + upstream (RunScope `card`).
  const integrated = spec.kind in LOWERED_CARD_ROWS;
  const runCardRow = editing?.runCardRow;
  const onRunRow =
    runCardRow && integrated ? (rowId: string) => runCardRow(id, rowId) : undefined;
  const runCard = editing?.runCard;
  const onRunCard = runCard && integrated ? () => runCard(id) : undefined;
  const shellSpec = spec.kind === "imageSource" ? { ...spec, outputs: [] } : spec;
  let nodeStyle: (CSSProperties & { "--image-source-card-width"?: string }) | undefined =
    undefined;
  if (slim && expandedHeight.current) {
    nodeStyle = { minHeight: expandedHeight.current };
  }
  if (imageSourceVisibleSlotCount) {
    nodeStyle = nodeStyle ?? {};
    nodeStyle["--image-source-card-width"] = `${imageSourceCardWidthForSlots(
      imageSourceVisibleSlotCount,
    )}px`;
  }

  return (
    <NodeCardShell
      spec={shellSpec}
      selected={!!selected}
      status={status}
      lod={lodTier}
      durationMs={d.durationMs}
      deviceReport={d.deviceReport}
      titleExtra={spec.kind === "psdTemplate" ? <span className="node-tag">PSD</span> : null}
      onSettings={() => editing?.onCardSettings?.(id)}
      portContent={slim ? undefined : portContent}
      onRunRow={slim ? undefined : onRunRow}
      runRowTitle={t("node.runRowTitle")}
      onRunCard={lod ? undefined : onRunCard}
      runCardTitle={t("node.runCardTitle")}
      rootRef={cardRef}
      style={nodeStyle}
    >
      {!slim && (status === "failed" || status === "cancelled") && d.error ? (
        <div className="node-error nodrag" title={d.error}>
          {d.error}
        </div>
      ) : null}

      {!slim && <div className="node-body">
        {inlineParams.length > 0 ? (
          <div className="inline-field-grid">{inlineParams.map(renderInlineParam)}</div>
        ) : null}

        {spec.kind === "promptOptimize" && editing?.openAssistant ? (
          <div className="subject-mask-actions nodrag">
            <button
              type="button"
              title={t("assistant.openFromCardTitle")}
              onClick={() => editing.openAssistant?.(id)}
            >
              {t("assistant.openFromCard")}
            </button>
          </div>
        ) : null}

        {spec.kind === "subjectMask" ? (
          <div className="subject-mask">
            {d.maskPath ? (
              <LazyThumb path={d.maskPath} />
            ) : (
              <div
                className="node-thumb placeholder click-select"
                title={t("node.clickSelectTitle")}
              >
                {isConnected("image") ? t("node.clickSelect") : t("node.connectImage")}
              </div>
            )}
            <div className="subject-mask-actions nodrag">
              <button
                type="button"
                title={t("node.autoTitle")}
                onClick={() => editing?.openPreview?.(id)}
              >
                {t("node.auto")}
              </button>
              <button
                type="button"
                className="primary"
                title={t("node.editMaskTitle")}
                onClick={() => editing?.openImageEditorForNode?.(id)}
              >
                {t("node.editMask")}
              </button>
              <button
                type="button"
                title={t("node.previewTitle")}
                onClick={() => editing?.openPreview?.(id)}
              >
                {t("node.preview")}
              </button>
            </div>
          </div>
        ) : null}

        {spec.kind === "crop" ? (
          <div className="subject-mask">
            {d.imagePath ? (
              <LazyThumb path={d.imagePath} />
            ) : (
              <div className="node-thumb placeholder" title={t("node.mediaCropTitle")}>
                {isConnected("image") ? t("crop.drawHint") : t("node.connectImage")}
              </div>
            )}
            <div className="subject-mask-actions nodrag">
              <button
                type="button"
                className="primary"
                title={t("crop.applyTitle")}
                onClick={() => editing?.openCropEdit?.(id)}
              >
                {t("crop.title")}
              </button>
            </div>
          </div>
        ) : null}

        {spec.kind === "imageGrade" ? (
          <div className="subject-mask">
            {d.imagePath ? (
              <LazyThumb path={d.imagePath} />
            ) : (
              <div className="node-thumb placeholder" title={t("grade.title")}>
                {isConnected("image") ? t("grade.editHint") : t("node.connectImage")}
              </div>
            )}
            <div className="subject-mask-actions nodrag">
              <button
                type="button"
                className="primary"
                title={t("grade.openTitle")}
                onClick={() => editing?.openGradeEdit?.(id)}
              >
                {t("grade.title")}
              </button>
            </div>
          </div>
        ) : null}

        {spec.kind === "imageSource" ? (
          <ImageSourceCard id={id} slots={imageSourceSlots} />
        ) : null}

        {spec.kind === "videoSource" && d.params.path ? (
          <VideoSourceCard
            path={String(d.params.path)}
            posterTimestamp={Number(d.params.poster_timestamp ?? 0)}
          />
        ) : null}

        {spec.kind === "psdTemplate" && templateWarn ? (
          <div className="node-warn nodrag" title={templateWarn}>
            ⚠ {templateWarn}
          </div>
        ) : null}

        {spec.kind === "save" ? (
          <div className="psd-conn">
            <span className={isConnected("image") ? "ok" : "warn"}>
              {t("node.connImage")} {isConnected("image") ? "✓" : "✕"}
            </span>
            <span className={isConnected("template") ? "ok" : "muted"}>
              {t("node.connTemplate")} {isConnected("template") ? "✓" : "—"}
            </span>
          </div>
        ) : null}

        {spec.kind === "psdExport" ? (
          <div className="psd-export">
            <div className="psd-conn">
              <span className={isConnected("image") ? "ok" : "warn"}>
                {t("node.connImage")} {isConnected("image") ? "✓" : "✕"}
              </span>
              <span className={isConnected("template") ? "ok" : "warn"}>
                {t("node.connTemplate")} {isConnected("template") ? "✓" : "✕"}
              </span>
            </div>
            {d.psdPreviewPath ? (
              <LazyThumb path={d.psdPreviewPath} />
            ) : (
              <div className="node-thumb placeholder">{t("node.noExport")}</div>
            )}
            {d.psdPath ? <PathRow label="psd" path={d.psdPath} /> : null}
            {d.psdPreviewPath ? <PathRow label="preview" path={d.psdPreviewPath} /> : null}
            {d.psdMetadataPath ? <PathRow label="meta" path={d.psdMetadataPath} /> : null}
            {d.placeholderKind || d.smartObjectMode ? (
              <small className="psd-meta">
                {d.placeholderKind ? `${t("node.metaPlaceholder")}: ${d.placeholderKind}` : ""}
                {d.placeholderKind && d.smartObjectMode ? " 路 " : ""}
                {d.smartObjectMode ? `${t("node.metaSmart")}: ${d.smartObjectMode}` : ""}
              </small>
            ) : null}
          </div>
        ) : null}
      </div>}
    </NodeCardShell>
  );
}

export const HgripeNode = memo(HgripeNodeImpl);
