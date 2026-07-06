// Geometry + persistence helpers for the floating assistant button: keep the
// button inside the viewport and tell an intentional drag apart from a click.

export interface FloatingPos {
  x: number;
  y: number;
}

/** Movement (px) beyond which a pointer gesture counts as a drag, not a click. */
export const DRAG_THRESHOLD_PX = 4;

const POS_KEY = "hgripe.studio.promptAssistant.buttonPos.v1";
const DOCK_POS_KEY = "hgripe.studio.promptAssistant.dockPos.v1";

/** Clamp a top-left position so a `size`-square button stays fully visible. */
export function clampToViewport(
  pos: FloatingPos,
  size: number,
  viewportW: number,
  viewportH: number,
): FloatingPos {
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, viewportW - size)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, viewportH - size)),
  };
}

export function isDragGesture(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > DRAG_THRESHOLD_PX;
}

function loadPos(key: string): FloatingPos | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as FloatingPos).x === "number" &&
      typeof (parsed as FloatingPos).y === "number"
    ) {
      return { x: (parsed as FloatingPos).x, y: (parsed as FloatingPos).y };
    }
    return null;
  } catch {
    return null;
  }
}

function savePos(key: string, pos: FloatingPos): void {
  try {
    localStorage.setItem(key, JSON.stringify(pos));
  } catch {
    // Persistence is best-effort (e.g. storage disabled).
  }
}

export function loadButtonPos(): FloatingPos | null {
  return loadPos(POS_KEY);
}

export function saveButtonPos(pos: FloatingPos): void {
  savePos(POS_KEY, pos);
}

export function loadDockPos(): FloatingPos | null {
  return loadPos(DOCK_POS_KEY);
}

export function saveDockPos(pos: FloatingPos): void {
  savePos(DOCK_POS_KEY, pos);
}
