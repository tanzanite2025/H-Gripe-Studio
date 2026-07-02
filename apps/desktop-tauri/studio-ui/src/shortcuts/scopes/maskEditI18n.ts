// Simplified-Chinese overlay for the Mask-Edit shortcut table
// (maskEdit.ts). MASK_EDIT_SHORTCUTS stays the English source of truth;
// this map holds only the zh hint per binding id; `localizeShortcut` blends
// them, falling back to English. A coverage test asserts every binding has an
// entry.

import type { Lang } from "../../i18n";
import type { ShortcutBinding } from "../core";

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
  tool_move: { hint: "移动工具（拖拽移动蒙版；Ctrl+T 打开自由变换）。" },
  tool_crop: { hint: "裁剪工具（拖出裁剪框；框外蒙版被清除）。" },
  tool_frame: { hint: "图框工具（规划中）。" },
  tool_eyedropper: { hint: "吸管工具（规划中）。" },
  tool_healing: { hint: "污点修复 / 修复画笔（规划中）。" },
  tool_clone: { hint: "仿制图章工具（规划中）。" },
  tool_history_brush: { hint: "历史记录画笔（规划中）。" },
  tool_gradient: { hint: "渐变 / 油漆桶工具（规划中）。" },
  tool_dodge_burn: { hint: "减淡 / 加深 / 海绵工具（规划中）。" },
  tool_type: { hint: "文字工具（规划中）。" },
  tool_path_select: { hint: "路径 / 直接选择工具（规划中；重编辑已提交的钢笔锚点需要它）。" },
  tool_shape: { hint: "形状工具（规划中）。" },
  tool_hand: { hint: "抓手工具（拖拽平移放大后的视图；任意工具下按住 Space 也可平移）。" },
  tool_rotate_view: { hint: "旋转视图工具（规划中）。" },
  tool_zoom: { hint: "缩放工具（点击放大，Alt+点击缩小）。" },
  default_colors: { hint: "重置为默认画笔 / 添加模式（对应 PS 默认前后景色）。" },
  quick_mask: { hint: "切换当前选区的快速蒙版（宝石红）叠加。" },
  screen_mode: { hint: "循环切换屏幕模式（规划中）。" },
  select_all: { hint: "全选（整个画布，作为一条历史步骤）。" },
  reselect: { hint: "重新选择：恢复上次清除所丢弃的选区。" },
  free_transform: { hint: "自由变换：移动 / 缩放 / 旋转蒙版，作为可随时改参的一步。" },
  adjust_levels: { hint: "新建 色阶 调整图层（PS 色阶为 Ctrl+L；这里 L 已是套索）。" },
  adjust_curve: { hint: "新建 曲线 调整图层（PS 曲线为 Ctrl+M；这里 M 已是框选）。" },
  duplicate: { hint: "通过拷贝复制当前图层。" },
  step_backward: { hint: "后退一步（PS 传统撤销）（规划中；Ctrl+Z 已可撤销）。" },
  fill_dialog: { hint: "填充对话框（规划中）。" },
  feather_dialog: { hint: "羽化对话框（规划中；目前羽化在工具栏操作）。" },
  delete_selection: { hint: "删除选区（作为一条历史步骤）。" },
  pan_space: { hint: "按住空格，任意工具下平移放大后的视图。" },
  zoom_in: { hint: "放大。" },
  zoom_out: { hint: "缩小。" },
  zoom_fit: { hint: "适应屏幕。" },
  zoom_100: { hint: "100% 缩放（一个图像像素对应一个屏幕像素）。" },
  brush_softer: { hint: "降低笔刷硬度（边缘更软）。" },
  brush_harder: { hint: "提高笔刷硬度（边缘更硬）。" },
};

/** Return the binding's `hint` translated into `lang` (English fallback). */
export function localizeShortcut(binding: ShortcutBinding, lang: Lang): { hint: string } {
  if (lang !== "zh") return { hint: binding.hint };
  return { hint: MASK_SHORTCUT_ZH[binding.id]?.hint ?? binding.hint };
}
