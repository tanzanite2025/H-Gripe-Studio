// Right rail — "Channels" panel (PS 通道): the mask document is grayscale,
// so it exposes the mask alpha plus PS's quick-mask overlay channel.

import { useEffect, useMemo, useRef } from "react";
import { useT } from "../../i18n";
import type { MaskLayer } from "../../types/production";
import { buildLayerThumb } from "../maskMorphology";

interface ChannelsPanelProps {
  layers: readonly MaskLayer[];
  active: number;
  dims: { w: number; h: number };
  quickMask: boolean;
  setQuickMask: (on: boolean) => void;
}

function ChannelThumb({ layer, dims }: { layer: MaskLayer; dims: { w: number; h: number } }) {
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

export function ChannelsPanel({ layers, active, dims, quickMask, setQuickMask }: ChannelsPanelProps) {
  const t = useT();
  const activeLayer = layers[active];
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
      <small className="muted mask-edit-note">{t("mask.channelsHint")}</small>
    </div>
  );
}
