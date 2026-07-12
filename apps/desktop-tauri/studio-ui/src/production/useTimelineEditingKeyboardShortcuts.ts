// Window-level keyboard shortcuts for editing the timeline while the
// production drawer is open. Kept out of the drawer component so the shortcut
// map is readable in one place.

import { useEffect } from "react";

import {
  copySelectedTimelineClipsToClipboard,
  cutSelectedTimelineClipsToClipboard,
  pasteTimelineClipboardAtTime,
  removeSelectedTimelineClips,
  setSequencePlaybackInPoint,
  setSequencePlaybackOutPoint,
  toggleTimelineMarker,
  type ProductionStore,
} from "./productionStore";

function isTypingInFormField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT")
  );
}

/**
 * Timeline keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo,
 * Ctrl+C / Ctrl+X / Ctrl+V copy / cut / paste-at-playhead the selected clips,
 * Delete / Backspace removes the selected clips, M toggles a sequence marker
 * and I / O set the playback in/out points at the playhead. Skipped while
 * typing in form fields or editable content, and detached while `enabled` is
 * false (drawer collapsed).
 */
export function useTimelineEditingKeyboardShortcuts(
  store: ProductionStore,
  playheadSecRef: { readonly current: number },
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isTypingInFormField(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        store.redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "c") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        copySelectedTimelineClipsToClipboard(store);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "x") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        cutSelectedTimelineClipsToClipboard(store);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") {
        if (store.getState().clipClipboard.length === 0) return;
        event.preventDefault();
        pasteTimelineClipboardAtTime(store, playheadSecRef.current);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (store.getState().selectedClipIds.length === 0) return;
        event.preventDefault();
        removeSelectedTimelineClips(store);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (key === "m") {
        event.preventDefault();
        toggleTimelineMarker(store, playheadSecRef.current);
        return;
      }
      if (key === "i") {
        event.preventDefault();
        setSequencePlaybackInPoint(store, playheadSecRef.current);
        return;
      }
      if (key === "o") {
        event.preventDefault();
        setSequencePlaybackOutPoint(store, playheadSecRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, store, playheadSecRef]);
}
