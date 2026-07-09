import { useEffect, useMemo, useState } from "react";

import {
  getRuntimeOutputDir,
  pickFolder,
} from "../bridge/files";
import type { ViewportFrameExportFormat } from "../bridge/viewport";
import { useT } from "../i18n";

export interface ExportFrameRequest {
  path: string;
  format: ViewportFrameExportFormat;
}

export interface ExportFrameResult {
  path: string;
  width: number;
  height: number;
  format: ViewportFrameExportFormat;
}

interface ExportFrameDialogProps {
  defaultName: string;
  onClose: () => void;
  onExport: (request: ExportFrameRequest) => Promise<ExportFrameResult>;
  onAddToProject?: (asset: { path: string; name: string }) => void;
}

const FORMAT_EXT: Record<ViewportFrameExportFormat, string> = {
  bmp: "bmp",
  png: "png",
  jpeg: "jpg",
};

function cleanFrameName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-");
}

export function buildExportFramePath(
  dir: string,
  name: string,
  format: ViewportFrameExportFormat,
): string {
  const cleanName = cleanFrameName(name) || "frame";
  const ext = FORMAT_EXT[format];
  const stem = cleanName.toLowerCase().endsWith(`.${ext}`)
    ? cleanName.slice(0, -ext.length - 1)
    : cleanName.replace(/\.[^.\\/]+$/, "");
  const sep = dir.includes("\\") ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  return `${base}${sep}${stem}.${ext}`;
}

type ExportState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "error"; message: string };

export function ExportFrameDialog({
  defaultName,
  onClose,
  onExport,
  onAddToProject,
}: ExportFrameDialogProps) {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState<ViewportFrameExportFormat>("bmp");
  const [dir, setDir] = useState("");
  const [addToProject, setAddToProject] = useState(true);
  const [state, setState] = useState<ExportState>({ phase: "idle" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getRuntimeOutputDir()
      .then((outputDir) => {
        if (!cancelled) setDir(outputDir);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const targetPath = useMemo(() => {
    if (!dir.trim()) return "";
    return buildExportFramePath(dir, name, format);
  }, [dir, name, format]);
  const canExport = !!targetPath && state.phase !== "running";

  const chooseDir = async () => {
    const picked = await pickFolder({
      title: t("exportFrame.pickPathTitle"),
      dir: dir || null,
    });
    if (picked) setDir(picked);
  };

  const confirm = async () => {
    if (!canExport) return;
    setState({ phase: "running" });
    try {
      const result = await onExport({ path: targetPath, format });
      if (addToProject) {
        onAddToProject?.({ path: result.path, name: cleanFrameName(name) || "frame" });
      }
      onClose();
    } catch (err) {
      setState({ phase: "error", message: String(err) });
    }
  };

  return (
    <div className="media-viewer-backdrop" onClick={onClose}>
      <div className="media-viewer export-dialog export-frame-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="media-viewer-bar">
          <span className="media-viewer-name">{t("exportFrame.title")}</span>
          <div className="media-viewer-actions">
            <button className="primary" onClick={confirm} disabled={!canExport} title={t("exportFrame.confirmTitle")}>
              {state.phase === "running" ? t("exportFrame.running") : t("exportFrame.confirm")}
            </button>
            <button onClick={onClose} title={t("export.closeTitle")}>
              ×
            </button>
          </div>
        </div>

        <div className="export-body">
          <label className="field export-frame-field">
            <span>{t("exportFrame.name")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field export-frame-field">
            <span>{t("exportFrame.format")}</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ViewportFrameExportFormat)}
            >
              <option value="bmp">BMP</option>
              <option value="png">PNG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
          <label className="field export-frame-field">
            <span>{t("exportFrame.path")}</span>
            <span className="export-frame-path-row">
              <input
                type="text"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
              />
              <button type="button" onClick={chooseDir}>
                {t("exportFrame.browse")}
              </button>
            </span>
          </label>
          <label className="field export-frame-check">
            <input
              type="checkbox"
              checked={addToProject}
              onChange={(e) => setAddToProject(e.target.checked)}
            />
            <span>{t("exportFrame.addToProject")}</span>
          </label>
          {targetPath ? (
            <p className="export-result" title={targetPath}>
              {targetPath}
            </p>
          ) : null}
          {state.phase === "error" ? <p className="export-error">{state.message}</p> : null}
        </div>
      </div>
    </div>
  );
}
