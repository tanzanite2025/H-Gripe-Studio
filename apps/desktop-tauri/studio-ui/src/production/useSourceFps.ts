// Source frame rate lookup for playback pacing: the monitor snaps playing
// frame requests onto the source's frame grid, which needs the clip's fps.
// Probed once per media path through `videoProbe` and cached for the
// component's lifetime; unknown/failed probes resolve to null (playback then
// paces on the request clock, exactly the pre-pacing behavior).

import { useEffect, useRef, useState } from "react";

import { videoProbe } from "../bridge/files";

export function useSourceFps(path: string | null): number | null {
  const [fps, setFps] = useState<number | null>(null);
  const cache = useRef(new Map<string, number | null>());
  useEffect(() => {
    if (!path) {
      setFps(null);
      return;
    }
    const cached = cache.current.get(path);
    if (cached !== undefined) {
      setFps(cached);
      return;
    }
    let cancelled = false;
    setFps(null);
    videoProbe(path)
      .then((probe) => {
        const value = probe.fps && probe.fps > 0 ? probe.fps : null;
        cache.current.set(path, value);
        if (!cancelled) setFps(value);
      })
      .catch(() => {
        cache.current.set(path, null);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return fps;
}
