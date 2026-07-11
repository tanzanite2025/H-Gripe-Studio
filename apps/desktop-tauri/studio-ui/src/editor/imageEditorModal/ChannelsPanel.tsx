// Right rail — "Channels" panel (PS 通道). The active mask is grayscale, so
// the mask workspace exposes the mask alpha plus PS's quick-mask overlay
// channel; the image workspace shows the image's composite and per-colour
// channels (RGB / red / green / blue), like PS.

import { useEffect, useMemo, useRef, useState } from "react";
import { generateThumbnail } from "../../bridge/tauri";
import { useT } from "../../i18n";
import { type ImageEditorLayer } from "../../contracts/imageEditorDocument";
import { buildLayerThumb } from "../maskMorphology";

interface ChannelsPanelProps {
  layers: readonly ImageEditorLayer[];
  active: number;
  dims: { w: number; h: number };
  quickMask: boolean;
  setQuickMask: (on: boolean) => void;
  /** Product surface: the image workspace shows colour channels of the image;
   * the mask workspace shows the mask alpha + quick-mask overlay. */
  workspace?: "image" | "mask";
  /** Backing source image for the image workspace's channel thumbnails. */
  imagePath?: string | null;
}

function ChannelThumb({ layer, dims }: { layer: ImageEditorLayer; dims: { w: number; h: number } }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumb = useMemo(() => buildLayerThumb(layer, dims), [layer.ops, dims]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = thumb.w;
    canvas.height = thumb.h;
    const img = ctx.createImageData(thumb.w, thumb.h);
    for (let i = 0; i < thumb.data.length; i++) {
      const v = thumb.data[i];
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [thumb]);
  return <canvas ref={canvasRef} className="mask-layer-thumb-canvas" aria-hidden="true" />;
}

interface ColourChannelThumbs {
  rgb: string;
  red: string;
  green: string;
  blue: string;
}

// The image's composite thumbnail plus per-colour grayscale extractions,
// decoded once per path from the shared thumbnail service.
function useColourChannelThumbs(imagePath: string | null | undefined): ColourChannelThumbs | null {
  const [thumbs, setThumbs] = useState<ColourChannelThumbs | null>(null);
  useEffect(() => {
    setThumbs(null);
    if (!imagePath) return;
    let alive = true;
    generateThumbnail({ path: imagePath, size: 96 })
      .then(
        (thumb) =>
          new Promise<ColourChannelThumbs | null>((resolve) => {
            if (!thumb.data_url) {
              resolve(null);
              return;
            }
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext("2d");
              if (!ctx) {
                resolve(null);
                return;
              }
              ctx.drawImage(img, 0, 0);
              const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const channel = (offset: number) => {
                const out = ctx.createImageData(canvas.width, canvas.height);
                for (let i = 0; i < src.data.length; i += 4) {
                  const v = src.data[i + offset];
                  out.data[i] = v;
                  out.data[i + 1] = v;
                  out.data[i + 2] = v;
                  out.data[i + 3] = 255;
                }
                ctx.putImageData(out, 0, 0);
                return canvas.toDataURL();
              };
              resolve({
                rgb: thumb.data_url,
                red: channel(0),
                green: channel(1),
                blue: channel(2),
              });
            };
            img.onerror = () => resolve(null);
            img.src = thumb.data_url;
          }),
      )
      .then((result) => {
        if (alive) setThumbs(result);
      })
      .catch(() => {
        if (alive) setThumbs(null);
      });
    return () => {
      alive = false;
    };
  }, [imagePath]);
  return thumbs;
}

function ColourChannelsPanel({ imagePath }: { imagePath: string | null | undefined }) {
  const t = useT();
  const thumbs = useColourChannelThumbs(imagePath);
  const rows = [
    { key: "rgb", label: t("mask.channelRgb"), src: thumbs?.rgb },
    { key: "red", label: t("mask.channelRed"), src: thumbs?.red },
    { key: "green", label: t("mask.channelGreen"), src: thumbs?.green },
    { key: "blue", label: t("mask.channelBlue"), src: thumbs?.blue },
  ] as const;
  return (
    <div className="mask-panel-body">
      <div className="mask-layer-list">
        {rows.map((row) => (
          <div key={row.key} className={`mask-layer-row${row.key === "rgb" ? " active" : ""}`}>
            <button className="mask-layer-visible" title={row.label} disabled>
              👁
            </button>
            <span className="mask-layer-thumb" aria-hidden="true">
              {row.src ? (
                <img className="mask-layer-thumb-img" src={row.src} alt="" draggable={false} />
              ) : (
                <span className="mask-layer-thumb-fallback">IMG</span>
              )}
            </span>
            <span className="mask-layer-name">{row.label}</span>
          </div>
        ))}
      </div>
      <small className="muted image-editor-note">{t("mask.channelsHintImage")}</small>
    </div>
  );
}

export function ChannelsPanel({
  layers,
  active,
  dims,
  quickMask,
  setQuickMask,
  workspace = "mask",
  imagePath,
}: ChannelsPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
  if (workspace === "image") return <ColourChannelsPanel imagePath={imagePath} />;
  return (
    <div className="mask-panel-body">
      <div className="mask-layer-list">
        <div className="mask-layer-row active">
          <button className="mask-layer-visible" title={t("mask.channelMask")} disabled>
            👁
          </button>
          <span className="mask-layer-thumb" aria-hidden="true">
            {activeLayer ? <ChannelThumb layer={activeLayer} dims={dims} /> : null}
          </span>
          <span className="mask-layer-name">{t("mask.channelMask")}</span>
        </div>
        <div className={`mask-layer-row${quickMask ? "" : " hidden"}`} onClick={() => setQuickMask(!quickMask)}>
          <button
            className="mask-layer-visible"
            title={quickMask ? t("mask.layerHide") : t("mask.layerShow")}
            onClick={(e) => {
              e.stopPropagation();
              setQuickMask(!quickMask);
            }}
          >
            {quickMask ? "👁" : ""}
          </button>
          <span className="mask-layer-thumb mask-channel-quick" aria-hidden="true">
            ◍
          </span>
          <span className="mask-layer-name">{t("mask.channelQuick")}</span>
        </div>
      </div>
      <small className="muted image-editor-note">{t("mask.channelsHint")}</small>
    </div>
  );
}
