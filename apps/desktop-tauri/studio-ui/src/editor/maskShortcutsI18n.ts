// Simplified-Chinese overlay for the Mask-Edit shortcut table
// (maskShortcuts.ts). MASK_EDIT_SHORTCUTS stays the English source of truth;
// this map holds only the zh hint per binding id; `localizeShortcut` blends
// them, falling back to English. A coverage test asserts every binding has an
// entry.

import type { Lang } from "../i18n";
import type { ShortcutBinding } from "./shortcuts";

export const MASK_SHORTCUT_ZH: Record<string, { hint: string }> = {
  tool_brush: { hint: "画笔工具。" },
  tool_eraser: { hint: "橡皮工具。" },
  tool_wand: { hint: "魔棒工具。" },
  tool_pen: { hint: "钢笔工具。" },
  tool_lasso: { hint: "套索工具。" },
  tool_rect: { hint: "矩形框选。" },
  tool_ellipse: { hint: "椭圆框选（PS 用 Shift+M 循环切换框选工具）。" },
  undo: { hint: "撤销上一步编辑。" },
  redo: { hint: "重做。" },
  redo_alt: { hint: "重做（备用键）。" },
  clear: { hint: "清空全部编辑（对应 PS 取消选择）。" },
  invert: { hint: "反相蒙版（对应 PS 反选）。" },
  brush_smaller: { hint: "减小笔刷。" },
  brush_larger: { hint: "增大笔刷。" },
  swap_mode: { hint: "交换加/减：画笔 ↔ 橡皮、路径模式 加 ↔ 减（对应 PS 交换前后景色）。" },
  close_path: { hint: "闭合当前钢笔路径（PS 用 Enter 闭合/提交路径）。" },
  cancel: { hint: "取消未完成的钢笔路径；再按一次关闭编辑器。" },
  toggle_overlay: { hint: "切换仅显示蒙版（对应 PS 隐藏附加内容）。" },
  tool_zoom: { hint: "缩放工具（规划中）。" },
  tool_hand: { hint: "抓手 / 平移工具（规划中）。" },
  tool_crop: { hint: "裁剪工具（规划中）。" },
  quick_mask: { hint: "快速蒙版预览切换（规划中）。" },
  free_transform: { hint: "自由变换（规划中）。" },
  feather_dialog: { hint: "羽化对话框（规划中；目前羽化在工具栏操作）。" },
};

/** Return the binding's `hint` translated into `lang` (English fallback). */
export function localizeShortcut(binding: ShortcutBinding, lang: Lang): { hint: string } {
  if (lang !== "zh") return { hint: binding.hint };
  return { hint: MASK_SHORTCUT_ZH[binding.id]?.hint ?? binding.hint };
}
