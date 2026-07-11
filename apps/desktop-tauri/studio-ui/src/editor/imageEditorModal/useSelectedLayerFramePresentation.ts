import { useEffect, useState } from "react";
import type { ImageEditorDocument } from "../../contracts/imageEditorDocument";
import {
  canResolveSelectedLayerFrame,
  resolveSelectedLayerFrame,
  type SelectedLayerFrame,
} from "../selectedLayerFrame";

interface UseSelectedLayerFramePresentationArgs {
  workspace: "image" | "mask";
  document: ImageEditorDocument;
  selectedLayerId: string | null;
  documentWidth: number;
  documentHeight: number;
  baseNeedsExplicitSource: boolean;
}

export interface SelectedLayerFramePresentation {
  frame: SelectedLayerFrame | null;
}

export function useSelectedLayerFramePresentation({
  workspace,
  document,
  selectedLayerId,
  documentWidth,
  documentHeight,
  baseNeedsExplicitSource,
}: UseSelectedLayerFramePresentationArgs): SelectedLayerFramePresentation {
  const [result, setResult] = useState<{
    document: ImageEditorDocument;
    selectedLayerId: string;
    documentWidth: number;
    documentHeight: number;
    frame: SelectedLayerFrame | null;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (error) throw error;

  const ready = canResolveSelectedLayerFrame({
    workspace,
    selectedLayerId,
    baseNeedsExplicitSource,
    documentWidth,
    documentHeight,
  });

  useEffect(() => {
    setError(null);
    if (!ready || !selectedLayerId) {
      setResult(null);
      return;
    }

    let cancelled = false;
    const request = {
      document,
      selectedLayerId,
      documentWidth,
      documentHeight,
    };
    void resolveSelectedLayerFrame(request).then(
      (frame) => {
        if (!cancelled) setResult({ ...request, frame });
      },
      (err) => {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, document, selectedLayerId, documentWidth, documentHeight]);

  const frame =
    ready &&
    result &&
    result.document === document &&
    result.selectedLayerId === selectedLayerId &&
    result.documentWidth === documentWidth &&
    result.documentHeight === documentHeight
      ? result.frame
      : null;

  return { frame };
}
