// Simplified-Chinese overlay for the Mask-Edit tool registry (maskTools.ts).
//
// MASK_TOOLS stays the English source of truth (the contract table in
// docs/cards/subject-mask-matte.md). This map holds only the zh label/hint per
// tool id; `localizeTool` blends them at render time, falling back to English
// for any missing entry. A coverage test asserts every tool has an entry.

import type { Lang } from "../i18n";
import type { MaskTool } from "./maskTools";

export const MASK_TOOL_ZH: Record<string, { label: string; hint: string }> = {
  brush: { label: "画笔", hint: "把蒙版涂进来。" },
  eraser: { label: "橡皮", hint: "把蒙版擦掉。" },
  point: {
    label: "点 (SAM 2)",
    hint: "左键点击主体以包含，右键点击以排除——SAM 2 根据你的点进行分割（auto 模式）。",
  },
  wand: { label: "魔棒", hint: "按颜色相似度漫水填充一个区域（wand_tolerance）。" },
  rect: { label: "矩形", hint: "框选添加一个矩形。" },
  ellipse: { label: "椭圆", hint: "框选添加一个椭圆。" },
  invert: { label: "反相", hint: "反相整个蒙版。" },
  fill_holes: { label: "填洞", hint: "封闭内部孔洞。" },
  smooth: { label: "平滑", hint: "形态学开/闭运算。" },
  grow: { label: "扩张", hint: "将蒙版膨胀 N 像素。" },
  shrink: { label: "收缩", hint: "将蒙版腐蚀 N 像素。" },
  feather: { label: "羽化", hint: "对蒙版边缘做高斯羽化。" },
  blur: { label: "模糊", hint: "对整个蒙版做 N 像素高斯模糊（可随时改参的滤镜一步）。" },
  sharpen: { label: "锐化", hint: "用 USM 锐化蒙版边缘 N 像素（可随时改参的滤镜一步）。" },
  matting: {
    label: "抠像",
    hint: "在 头发 / 绒毛 / 玻璃 上涂出三分图未知带——抠像器会将其解算为软 alpha。",
  },
  pen: {
    label: "钢笔",
    hint: "点击放置锚点；点击第一个锚点（或 闭合路径）即可闭合——运行时栅格化并布尔合并。",
  },
  lasso: { label: "套索", hint: "围绕主体自由拖拽一圈；松开后闭合为一条路径选区。" },
  gradient: { label: "渐变", hint: "拖拽 起点 → 终点：从完全选中到无的线性渐变，作为可随时改参的一步（按住 Alt 拖拽为减去）。" },
  move: { label: "移动", hint: "拖拽以移动蒙版；Ctrl+T 打开自由变换（移动 / 缩放 / 旋转，可随时改参）。" },
  crop: { label: "裁剪", hint: "拖出裁剪框——框外的蒙版被清除（可随时改参的一步）。" },
  hand: { label: "抓手", hint: "拖拽以平移放大后的视图（任意工具下按住 Space 也可平移）。" },
  rotate_view: { label: "旋转视图", hint: "拖拽绕中心旋转视图——仅屏幕空间，不改动蒙版（Esc 复位，Ctrl+0 适应屏幕并复位）。" },
  zoom: { label: "缩放", hint: "点击处放大，Alt+点击缩小（Ctrl+0 适应屏幕，Ctrl+1 100%）。" },
  eyedropper: { label: "吸管", hint: "吸管：点击取样光标下的图像颜色——色样显示在工具选项里。" },
  heal: { label: "污点修复", hint: "污点修复画笔：涂抹瑕疵区域，由周围蒙版平滑重建（可随时改参的一步）。" },
  clone: { label: "仿制图章", hint: "仿制图章：Alt+点击设定源点，涂抹时按源点偏移复制蒙版（可随时改参的一步）。" },
  history_brush: { label: "历史画笔", hint: "历史记录画笔：把区域涂抹回图层初始状态——所有编辑步骤之前的蒙版（可随时改参的一步）。" },
  dodge_burn: { label: "减淡/加深", hint: "减淡/加深：涂抹局部提亮蒙版（按住 Alt 拖拽为压暗）——可随时改参的一步。" },
};

/** Return the tool's `label` / `hint` translated into `lang` (English fallback). */
export function localizeTool(tool: MaskTool, lang: Lang): { label: string; hint: string } {
  if (lang !== "zh") return { label: tool.label, hint: tool.hint };
  const tr = MASK_TOOL_ZH[tool.id];
  return { label: tr?.label ?? tool.label, hint: tr?.hint ?? tool.hint };
}
