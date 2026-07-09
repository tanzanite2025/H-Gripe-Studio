import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import NodeEditor from "./App";
import { LangContext, loadLang, saveLang, type Lang } from "./i18n";
import "./styles.css";
import "./styles/modals.css";
import "./styles/production-drawer.css";

// The node editor is the application: it boots straight into the main canvas
// (the former Dashboard / PSD Studio / Run / History / PSD console tabs were
// legacy shell-ui remnants, replaced by canvas cards and the drawer).
function Root() {
  const [lang, setLang] = useState<Lang>(() => loadLang());
  const toggleLang = useCallback(() => {
    setLang((prev) => {
      const next: Lang = prev === "en" ? "zh" : "en";
      saveLang(next);
      return next;
    });
  }, []);

  return (
    <LangContext.Provider value={lang}>
      <NodeEditor onToggleLang={toggleLang} />
    </LangContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
