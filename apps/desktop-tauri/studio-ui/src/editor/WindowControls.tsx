import { tauriWindow, type TauriDesktopWindow } from "../bridge/core";
import { useT } from "../i18n";

async function runWindowAction(action: (win: TauriDesktopWindow) => Promise<void>) {
  const win = tauriWindow();
  if (!win) return;
  try {
    await action(win);
  } catch {}
}

export function WindowControls() {
  const t = useT();

  return (
    <div className="window-controls" aria-label={t("win.controls")}>
      <button
        className="win-btn win-close"
        onClick={() => void runWindowAction((win) => win.close())}
        aria-label={t("win.close")}
        title={t("win.close")}
      >
        <span className="win-glyph" aria-hidden="true">
          {"\u00d7"}
        </span>
      </button>
      <button
        className="win-btn win-minimize"
        onClick={() => void runWindowAction((win) => win.minimize())}
        aria-label={t("win.minimize")}
        title={t("win.minimize")}
      >
        <span className="win-glyph" aria-hidden="true">
          {"\u2212"}
        </span>
      </button>
      <button
        className="win-btn win-maximize"
        onClick={() => void runWindowAction((win) => win.toggleMaximize())}
        aria-label={t("win.maximize")}
        title={t("win.maximize")}
      >
        <span className="win-glyph" aria-hidden="true">
          {"\u2922"}
        </span>
      </button>
    </div>
  );
}
