import { useEffect, useState, type RefObject } from "react";

export interface ObservedElementSize {
  w: number;
  h: number;
}

/** Track a mounted element's positive, integer CSS-pixel dimensions. */
export function useObservedElementSize(
  elementRef: RefObject<HTMLElement | null>,
): ObservedElementSize | null {
  const [size, setSize] = useState<ObservedElementSize | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const read = () => {
      const next = {
        w: Math.round(element.clientWidth),
        h: Math.round(element.clientHeight),
      };
      if (next.w <= 0 || next.h <= 0) return;
      setSize((current) => (
        current && current.w === next.w && current.h === next.h ? current : next
      ));
    };

    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);

  return size;
}
