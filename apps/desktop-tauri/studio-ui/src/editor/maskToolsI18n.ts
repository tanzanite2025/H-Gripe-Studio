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
  shape: { label: "形状", hint: "形状：拖出一个框——所选形状（三角/多边形/星形/直线）作为普通路径步骤提交（添加/减去/交集）。" },
  heal: { label: "污点修复", hint: "污点修复画笔：涂抹瑕疵区域，由周围蒙版平滑重建（可随时改参的一步）。" },
  clone: { label: "仿制图章", hint: "仿制图章：Alt+点击设定源点，涂抹时按源点偏移复制蒙版（可随时改参的一步）。" },
  history_brush: { label: "历史画笔", hint: "历史记录画笔：把区域涂抹回图层初始状态——所有编辑步骤之前的蒙版（可随时改参的一步）。" },
  dodge_burn: { label: "减淡/加深", hint: "减淡/加深：涂抹局部提亮蒙版（按住 Alt 拖拽为压暗）——可随时改参的一步。" },
  polygon_lasso: { label: "多边形套索", hint: "多边形套索：沿主体点击直线段，点击起点（或闭合路径）完成。" },
  magnetic_lasso: { label: "磁性套索", hint: "磁性套索：拖出套索圈，松开时各点自动吸附到附近的图像边缘。" },
  object_select: { label: "对象选择", hint: "对象选择：框选后由模型自动生成框内对象的蒙版（规划中）。" },
  quick_select: { label: "快速选择", hint: "快速选择：在主体上涂抹——每个点都作为种子按容差漫水填充，并入蒙版。" },
  perspective_crop: { label: "透视裁剪", hint: "透视裁剪：拖出四边形并拉直为矩形（规划中）。" },
  color_sampler: { label: "颜色取样器", hint: "颜色取样器：点击固定最多四个持续显示的颜色读数，列在工具选项里。" },
  ruler: { label: "标尺", hint: "标尺：拖拽测量距离和角度——纯视图读取，不记录任何编辑。" },
  remove: { label: "移除工具", hint: "移除工具：刷过物体后由模型填补该区域（规划中）。" },
  healing_brush: { label: "修复画笔", hint: "修复画笔：Alt+点击设定源点，涂抹时按源点偏移复制蒙版并以羽化边缘融入周围（可随时改参的一步）。" },
  patch: { label: "修补", hint: "修补：套索一块区域后拖到干净纹理上进行修复（规划中）。" },
  content_aware_move: { label: "内容感知移动", hint: "内容感知移动：拖动选区，原位置自动填补（规划中）。" },
  red_eye: { label: "红眼", hint: "红眼：点击瞳孔去除红色反光（规划中）。" },
  pencil: { label: "铅笔", hint: "铅笔：硬边缘笔触——硬度与流量锁定 100% 的画笔。" },
  color_replacement: { label: "颜色替换", hint: "颜色替换：保留纹理的同时涂上新的色相（规划中）。" },
  mixer_brush: { label: "混合器画笔", hint: "混合器画笔：像湿颜料一样混合颜色（规划中）。" },
  pattern_stamp: { label: "图案图章", hint: "图案图章：用重复图案进行涂抹（规划中）。" },
  art_history_brush: { label: "历史艺术画笔", hint: "历史记录艺术画笔：以历史状态为源的风格化笔触（规划中）。" },
  background_eraser: { label: "背景橡皮擦", hint: "背景橡皮擦：涂抹时把与画笔中心取样色相似的像素从蒙版中擦除（由容差驱动）。" },
  magic_eraser: { label: "魔术橡皮擦", hint: "魔术橡皮擦：点击把相似颜色从蒙版中擦除——会减去的魔棒漫水填充。" },
  paint_bucket: { label: "油漆桶", hint: "油漆桶：点击把相似颜色漫水填充进蒙版（由容差驱动，同魔棒）。" },
  sponge: { label: "海绵", hint: "海绵：涂抹把蒙版推向硬性开/关（按住 Alt 拖拽则软化向中灰）——可随时改参的一步。" },
  freeform_pen: { label: "自由钢笔", hint: "自由钢笔：徒手拖拽绘制路径，松开后自动闭合为路径选区。" },
  curvature_pen: { label: "弯度钢笔", hint: "弯度钢笔：点击各点，闭合时自动拟合穿过各点的平滑闭合曲线。" },
  type_horizontal: { label: "横排文字", hint: "横排文字：点击放置可编辑文本（规划中）。" },
  type_vertical: { label: "直排文字", hint: "直排文字：点击放置竖排可编辑文本（规划中）。" },
  path_select: { label: "路径选择", hint: "路径选择：点击已提交路径选中它，拖动移动整条路径（点「完成」提交）。" },
  direct_select: { label: "直接选择", hint: "直接选择：点击已提交路径选中它，拖动单个锚点（点「完成」提交）。" },
};

/** Return the tool's `label` / `hint` translated into `lang` (English fallback). */
export function localizeTool(tool: MaskTool, lang: Lang): { label: string; hint: string } {
  if (lang !== "zh") return { label: tool.label, hint: tool.hint };
  const tr = MASK_TOOL_ZH[tool.id];
  return { label: tr?.label ?? tool.label, hint: tr?.hint ?? tool.hint };
}
