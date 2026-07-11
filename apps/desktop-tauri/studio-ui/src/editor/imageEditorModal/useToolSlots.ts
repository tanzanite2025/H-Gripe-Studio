import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { imageEditorTool, PS_SLOTS, psSlotOf } from "../imageEditorTools";

interface UseToolSlotsArgs {
  initialToolId: string;
  onBeforeSelect: (toolId: string) => void;
}

export interface ToolSlotsController {
  toolId: string;
  setToolId: Dispatch<SetStateAction<string>>;
  slotFaces: Record<string, string>;
  setSlotFace: (slotId: string, toolId: string) => void;
  selectTool: (toolId: string) => void;
  selectSlot: (slotId: string) => void;
  cycleSlot: (slotId: string) => void;
}

export function useToolSlots({
  initialToolId,
  onBeforeSelect,
}: UseToolSlotsArgs): ToolSlotsController {
  const [toolId, setToolId] = useState(initialToolId);
  const [slotFaces, setSlotFaces] = useState<Record<string, string>>({});
  const beforeSelectRef = useRef(onBeforeSelect);
  beforeSelectRef.current = onBeforeSelect;

  const setSlotFace = useCallback((slotId: string, selectedToolId: string) => {
    setSlotFaces((faces) => ({ ...faces, [slotId]: selectedToolId }));
  }, []);

  const selectTool = useCallback((selectedToolId: string) => {
    beforeSelectRef.current(selectedToolId);
    setToolId(selectedToolId);
    const slot = psSlotOf(selectedToolId);
    if (slot && slot.variants.length > 1) setSlotFace(slot.id, selectedToolId);
  }, [setSlotFace]);

  const selectSlot = useCallback((slotId: string) => {
    const slot = PS_SLOTS.find((candidate) => candidate.id === slotId);
    if (!slot) return;
    const ready = slot.variants.filter((id) => imageEditorTool(id)?.status === "ready");
    if (ready.length === 0) return;
    const remembered = slotFaces[slotId];
    selectTool(remembered && ready.includes(remembered) ? remembered : ready[0]);
  }, [selectTool, slotFaces]);

  const cycleSlot = useCallback((slotId: string) => {
    const slot = PS_SLOTS.find((candidate) => candidate.id === slotId);
    if (!slot) return;
    const ready = slot.variants.filter((id) => imageEditorTool(id)?.status === "ready");
    if (ready.length === 0) return;
    const currentIndex = ready.indexOf(toolId);
    if (currentIndex === -1) {
      selectSlot(slotId);
      return;
    }
    selectTool(ready[(currentIndex + 1) % ready.length]);
  }, [selectSlot, selectTool, toolId]);

  return {
    toolId,
    setToolId,
    slotFaces,
    setSlotFace,
    selectTool,
    selectSlot,
    cycleSlot,
  };
}
