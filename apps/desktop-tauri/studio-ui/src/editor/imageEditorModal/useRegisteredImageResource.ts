import { useEffect, useState } from "react";
import { probeImageDims, registerResource } from "../../bridge/files";

export interface RegisteredImageResourceState {
  resourceId: string | null;
  dimensions: { w: number; h: number } | null;
}

export function useRegisteredImageResource(
  backingImagePath: string | null | undefined,
): RegisteredImageResourceState {
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!backingImagePath) {
      setResourceId(null);
      setDimensions(null);
      return;
    }

    setResourceId(null);
    setDimensions(null);
    void (async () => {
      const resource = await registerResource(backingImagePath);
      if (cancelled) return;
      setResourceId(resource?.id ?? null);
      if (resource?.width && resource.height) {
        setDimensions({ w: resource.width, h: resource.height });
        return;
      }

      const probed = await probeImageDims(backingImagePath);
      if (!cancelled) {
        setDimensions(probed?.width && probed.height ? { w: probed.width, h: probed.height } : null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backingImagePath]);

  return { resourceId, dimensions };
}
