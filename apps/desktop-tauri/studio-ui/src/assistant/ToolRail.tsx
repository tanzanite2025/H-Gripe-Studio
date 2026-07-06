import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { EyesIcon } from "./EyesIcon";
import {
  clampToViewport,
  isDragGesture,
  loadButtonPos,
  saveButtonPos,
  type FloatingPos,
} from "./floatingButton";

interface ToolRailProps {
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}

const BUTTON_SIZE = 80;

function defaultPos(): FloatingPos {
  return { x: window.innerWidth - BUTTON_SIZE - 16, y: Math.round(window.innerHeight * 0.45) };
}

// Floating assistant launcher (PROMPT_ASSISTANT_SYSTEM_PLAN): a draggable
// round button that stays above every other surface (media editor, drawers,
// modals) so the Prompt Assistant is always one click away. Position is
// per-workspace persisted; a small pointer movement still counts as a click.
export function ToolRail({ assistantOpen, onToggleAssistant }: ToolRailProps) {
  const t = useT();
  const [pos, setPos] = useState<FloatingPos>(() =>
    clampToViewport(loadButtonPos() ?? defaultPos(), BUTTON_SIZE, window.innerWidth, window.innerHeight),
  );
  // Live drag state kept in refs so the move handler never re-subscribes.
  const drag = useRef<{ startX: number; startY: number; origin: FloatingPos; moved: boolean } | null>(
    null,
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startY: e.clientY, origin: pos, moved: false };
    },
    [pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && !isDragGesture(d.startX, d.startY, e.clientX, e.clientY)) return;
    d.moved = true;
    setPos(
      clampToViewport(
        { x: d.origin.x + (e.clientX - d.startX), y: d.origin.y + (e.clientY - d.startY) },
        BUTTON_SIZE,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (d?.moved) {
        setPos((p) => {
          saveButtonPos(p);
          return p;
        });
      } else {
        onToggleAssistant();
      }
    },
    [onToggleAssistant],
  );

  // Keep the button on-screen when the window shrinks.
  useEffect(() => {
    const onResize = () =>
      setPos((p) => clampToViewport(p, BUTTON_SIZE, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <button
      className={assistantOpen ? "assistant-fab active" : "assistant-fab"}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={t("assistant.title")}
      aria-label={t("assistant.title")}
      aria-pressed={assistantOpen}
    >
      <EyesIcon size={52} />
    </button>
  );
}
