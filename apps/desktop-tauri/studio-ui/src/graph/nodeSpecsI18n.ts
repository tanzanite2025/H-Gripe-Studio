// Simplified-Chinese overlay for the node catalogue (NODE_SPECS).
//
// NODE_SPECS stays the English source of truth (runtime/validation/tests read
// it directly, and English is the fallback). This file holds *only* the zh
// translations of the human-readable card strings — node title/description,
// each param's label/hint, and each port's label — keyed by node kind. Option
// values are intentionally not translated: they are technical enum tokens used
// as the stored param value (e.g. "image.generate", "hybrid").
//
// `localizeSpec` clones a spec with the zh strings applied; any string missing
// a translation falls back to its English original. A coverage test
// (nodeSpecsI18n.test.ts) walks NODE_SPECS and asserts every translatable
// string has a zh entry, so new nodes/params cannot silently ship English-only.

import type { Lang } from "../i18n";
import { type NodeSpec } from "./nodeSpecs";

export interface NodeSpecZh {
  title: string;
  description: string;
  /** Param key -> translated label / hint (hint only where the English param has one). */
  params?: Record<string, { label?: string; hint?: string }>;
  /** Port id -> translated label (inputs and outputs share the id namespace). */
  ports?: Record<string, string>;
}

const OUTPUT_DIR_HINT = "留空则使用已配置的输出目录";

/** The Group container is described in Palette.tsx, not NODE_SPECS. */
export const GROUP_ZH = {
  title: "分组",
  description: "可调整大小的框。将节点拖入即可分组；成员一起移动。",
};

export const NODE_ZH: Record<string, NodeSpecZh> = {
  promptOptimize: {
    title: "提示词",
    description:
      "送入生成节点的文本提示词。可用确定性的内置预设或 API 配置进行优化；关闭优化时直接输出原文。",
    params: {
      text: { label: "提示词", hint: "初始提示词（连接的 `text` 输入会覆盖它）" },
      mode: { label: "优化", hint: "off = 直通 · builtin = 确定性规则 · api = 经配置走 LLM" },
      preset: { label: "内置预设", hint: "`builtin` 模式使用：去重 + 追加增强标签" },
      api_profile_ref: {
        label: "API 配置引用",
        hint: "来自「模型 / API」管理器的托管后端引用（由后端选择器设置）",
      },
      provider: { label: "提供方", hint: "`api` 模式使用（选择档案时自动设置）" },
      model: { label: "模型", hint: "`api` 模式使用" },
      instruction: { label: "指令", hint: "`api` 模式使用（作为系统提示发送）" },
      credentials_ref: { label: "凭据", hint: "`api` 模式使用（选择档案时自动设置）" },
      temperature: { label: "温度", hint: "`api` 模式使用（可选）：采样随机性，留空则用提供方默认值" },
      max_tokens: { label: "最大 token 数", hint: "`api` 模式使用（可选）：限制优化后提示词长度" },
      seed: { label: "种子", hint: "`api` 模式使用（可选）：固定以获得可复现输出" },
    },
    ports: { text: "文本" },
  },
  imageSource: {
    title: "图像源",
    description: "磁盘上的图像文件，用作参考图 / 输入图。",
    params: { path: { label: "图像路径", hint: "图像文件的绝对路径" } },
    ports: { image: "图像" },
  },
  videoSource: {
    title: "视频源",
    description: "磁盘上的视频文件；显示海报帧并将路径透传给下游。",
    params: {
      path: { label: "视频路径", hint: "视频文件的绝对路径" },
      poster_timestamp: { label: "海报时间（秒）", hint: "海报帧的时间点（秒）" },
    },
    ports: { video: "视频" },
  },
  psdTemplate: {
    title: "PSD 模板",
    description: "贯穿到导出的 .psd 模板路径。",
    params: { path: { label: "模板路径", hint: ".psd 模板的绝对路径" } },
    ports: { template: "模板" },
  },
  number: {
    title: "数值",
    description: "送入其它节点的数值（种子、数量……）。",
    params: { value: { label: "值" } },
    ports: { value: "值" },
  },
  generate: {
    title: "生成",
    description: "通过 H-Gripe broker 运行一次图像生成操作。",
    params: {
      api_profile_ref: {
        label: "API 配置引用",
        hint: "来自「模型 / API」管理器的托管后端引用（由后端选择器设置）",
      },
      provider: { label: "提供方" },
      operation: { label: "操作" },
      model: { label: "模型" },
      size: { label: "尺寸" },
      steps: { label: "步数" },
      seed: { label: "种子", hint: "被连接的 seed 输入覆盖" },
      credentials_ref: { label: "凭据", hint: "选择档案时自动设置" },
    },
    ports: { prompt: "提示词", reference: "参考图", seed: "种子", image: "图像" },
  },
  compare: {
    title: "比较",
    description:
      "比较两个值并输出 1（真）或 0（假）。两侧都能解析为数字时按数值比较，否则按字符串比较。将 `result` 接入 If 的 `cond`。",
    params: { op: { label: "运算符" } },
    ports: { a: "a", b: "b", result: "结果" },
  },
  logic: {
    title: "逻辑",
    description:
      "对输入的真值做布尔运算，输出 1（真）或 0（假）。`not` 只使用 `a`。将 `result` 接入 If 的 `cond`。",
    params: { op: { label: "运算符" } },
    ports: { a: "a", b: "b", result: "结果" },
  },
  if: {
    title: "If 条件",
    description:
      "条件门：根据条件将 `value` 转发到 `true` 或 `false` 输出。未选中的分支会被剪除（其下游节点被跳过）。",
    params: { cond: { label: "条件（未接入输入时）", hint: "若连接了 `cond` 输入，以其真值为准。" } },
    ports: { value: "值", cond: "条件", true: "真", false: "假" },
  },
  switch: {
    title: "Switch 分支",
    description:
      "多路路由：将 `value` 转发到与 `index`（0/1/2）匹配的输出，否则到 `default`。未选中的分支会被剪除（跳过）。",
    params: { index: { label: "索引（未接入输入时）" } },
    ports: { value: "值", index: "索引", "0": "0", "1": "1", "2": "2", default: "默认" },
  },
  reroute: {
    title: "中继",
    description: "直通中继：原样转发输入。用它整理过长的连线、在画布上绕线。",
    ports: { in: "输入", out: "输出" },
  },
  save: {
    title: "导出",
    description: "汇聚节点：收集结果图像路径（及可选的 PSD 模板）以供导出。",
    params: { filename: { label: "文件名" } },
    ports: { image: "图像", template: "模板" },
  },
  psdContextAnalyze: {
    title: "PSD 上下文分析",
    description:
      "将 PSD 模板读取为结构化的视觉上下文：背景色与光照启发、占位符几何与安全区、占位符蒙版与背景预览，以及供下游生成使用的提示词后缀。",
    params: {
      psd_path: { label: "PSD 路径", hint: "未连接 PSD Template 节点时使用" },
      background_layer: { label: "背景图层", hint: "要采样的图层（空 = 合成整个 PSD）" },
      target_placeholder: { label: "占位符图层", hint: "要测量的占位符（空 = 整张画布）" },
      reference_layers: { label: "参考图层", hint: "每行一个图层名（Phase 1 中仅供参考）" },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
    },
    ports: {
      template: "模板",
      visual_context: "视觉上下文",
      prompt_suffix: "提示词后缀",
      background_image: "背景",
      placeholder_mask: "占位符蒙版",
      placeholder_bounds: "占位符边界",
    },
  },
  matchLightColor: {
    title: "光照与色彩匹配",
    description:
      "将生成主体的光照与色彩向 PSD 背景靠拢，让合成不再显得「贴上去」：Reinhard Lab 迁移 / 直方图匹配，并向阴影与高光加权，同时保护品牌色。输出匹配后图像、匹配报告与提示词后缀。",
    params: {
      mode: { label: "模式" },
      strength: { label: "强度" },
      shadow_strength: { label: "阴影强度", hint: "阴影区的额外校正权重" },
      highlight_strength: { label: "高光强度", hint: "高光区的额外校正权重" },
      protect_brand_color: {
        label: "保护品牌色",
        hint: "抑制高彩度（品牌）像素的偏移，让 logo/包装保持原色",
      },
      protect_saturation: { label: "保护饱和度", hint: "只匹配亮度，保留主体自身的彩度" },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "匹配后 PNG 的基础名（空 = <image>_matched）" },
    },
    ports: {
      image: "图像",
      visual_context: "视觉上下文",
      background: "背景",
      mask: "蒙版",
      matched_image: "匹配后图像",
      match_report: "匹配报告",
      prompt_suffix: "提示词后缀",
    },
  },
  imageProcessing: {
    title: "图像处理",
    description:
      "一张集成的图像处理生产卡片，按语义行组织：图层拆分、增强、调色、裁剪/变换、修复/重绘。想用哪个操作就连接哪一行——每行有自己的输入/输出连接点，运行时拆解为对应的内部操作（智能图层拆分、图像增强、调色、裁剪、细节重绘）。",
    params: {
      "layerSplit.selected_kind": {
        label: "图层拆分：选中图层",
        hint: "layerSplit.out 行的资产将哪一层标记为选中",
      },
      "enhance.mode": { label: "增强：模式" },
      "grade.format": { label: "调色：输出格式" },
      "crop.mode": { label: "裁剪：模式" },
      "crop.aspect": { label: "裁剪：宽高比" },
      "repair.api_profile_ref": {
        label: "修复：API 配置引用",
        hint: "来自「模型 / API」管理器的托管后端引用（由后端选择器设置）",
      },
    },
    ports: {
      "layerSplit.in": "图层拆分",
      "enhance.in": "增强",
      "grade.in": "调色",
      "crop.in": "裁剪 / 变换",
      "repair.in": "修复 / 重绘",
      "repair.report": "质量报告",
      "layerSplit.out": "分层资产",
      "enhance.out": "增强图像",
      "grade.out": "调色图像",
      "crop.out": "裁剪图像",
      "repair.out": "修复图像",
    },
  },
  videoProcessing: {
    title: "视频处理",
    description:
      "一张集成的视频处理生产卡片，按语义行组织：合成（把帧序列编码为视频）和剪辑（从片段中截取时间范围）。想用哪个操作就连接哪一行——每行有自己的输入/输出连接点，运行时拆解为对应的内部操作（视频合成、视频剪辑）。",
    params: {
      "assemble.fps": { label: "合成：帧率", hint: "输出帧率" },
      "assemble.codec": {
        label: "合成：编码器",
        hint: "ffmpeg 编码器；libx264 兼容性最好",
      },
      "trim.start_sec": { label: "剪辑：起始秒", hint: "截取起点（从开头算起的秒数）" },
      "trim.end_sec": { label: "剪辑：结束秒", hint: "截取终点（秒；0 = 到片段结尾）" },
      "trim.codec": {
        label: "剪辑：编码器",
        hint: "重编码用的 ffmpeg 编码器；libx264 兼容性最好",
      },
    },
    ports: {
      "assemble.in": "合成帧序列",
      "trim.in": "剪辑",
      "assemble.out": "合成视频",
      "trim.out": "剪辑视频",
    },
  },
  smartLayerSplit: {
    title: "智能图层拆分",
    description:
      "把连接的图像拆分成 LayeredImageAsset：一个锁定的原图层，加上背景/主体候选层。连接视频时先把它解码为最接近帧时间的静帧再拆分（仅桌面运行时；图像和视频都连接时视频优先）。桌面运行时在进程内分割主体（有模型权重用模型后端，否则用确定性的内置 CPU 分割器），并写出每层的 mask + RGBA PNG；浏览器预览保留占位 mask。下游节点、Review 编辑器、调色和时间线消费 layered_asset / 图层端口。",
    params: {
      selected_kind: { label: "选中图层", hint: "selected_layer 输出发出的图层" },
      instancing: {
        label: "实例分层",
        hint: "auto 把主体 mask 按连通域拆成多个物体实例层（面积从大到小）——仅桌面运行时；每个实例都会标记待审",
      },
      detect_text: {
        label: "检测文字",
        hint: "把疑似文字行检测为受保护的文字候选层（启发式边缘密度检测）——仅桌面运行时；每个区域都会标记待审",
      },
      detect_logo: {
        label: "检测 logo",
        hint: "把画布边缘附近紧凑的高对比标记检测为受保护的 logo 候选层（启发式）——仅桌面运行时；每个区域都会标记待审",
      },
      detect_shadow: {
        label: "检测阴影",
        hint: "把主体旁比背景基准更暗的区域检测为投影候选层（启发式亮度检测）——仅桌面运行时；会标记待审",
      },
      detect_reflection: {
        label: "检测反光",
        hint: "把主体下方更暗的垂直镜像区域检测为反光候选层（启发式镜像亮度检测）——仅桌面运行时；会标记待审",
      },
      frame_sec: {
        label: "帧时间 (s)",
        hint: "连接视频时要拆分的静帧时间戳（秒）——仅桌面运行时",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "每层 PNG 的基础名（空 = <image>_split）" },
    },
    ports: {
      image: "图像",
      video: "视频",
      layered_asset: "分层资产",
      composite_preview: "合成预览",
      selected_layer: "选中图层",
      masks: "mask 集",
      split_report: "拆分报告",
    },
  },
  crop: {
    title: "裁剪",
    description:
      "裁剪图像——首个非蒙版编辑，用于端到端验证统一的自动/手动 + 绑定模型。在原生 Rust 内进程的 Compute 通路运行。manual（手动）模式裁剪到编辑器中绘制的裁剪框（记录为图像像素坐标的 crop_box，属人为空间意图通路）；auto_subject（自动到主体）模式裁剪到主体——它用与 Subject Mask 相同的 Compute 通路分割器算出基底抠像，取其包围盒并按主体边距外扩（属算法推导通路）。两条通路之后都可选按宽高比调整裁剪框（居中、裁剪到图像内）。输出裁剪后的图像与裁剪报告。",
    params: {
      mode: {
        label: "模式",
        hint: "manual 裁剪到编辑器中绘制的框；auto_subject 裁剪到检测出的主体",
      },
      aspect: {
        label: "宽高比",
        hint: "把裁剪锁定到某个宽高比（居中、裁剪到图像内）；free 保持绘制的框",
      },
      margin_pct: {
        label: "主体边距 %",
        hint: "在检测出的主体周围保留的内边距（仅 auto_subject 模式）",
      },
      format: {
        label: "输出格式",
        hint: "png（默认）或 16-bit tiff；宽色域源两者都保留 16-bit + ICC",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "裁剪后文件的基础名（空 = <image>_crop）" },
    },
    ports: {
      image: "图像",
      crop_report: "裁剪报告",
    },
  },
  imageGrade: {
    title: "调色",
    description:
      "用 hgripe-grade 内核对图像进行调色：在调色对话框中编排曝光、白平衡、对比度、饱和度、RGB 混合、色彩扭曲、锐化、降噪、颗粒和暗角等操作。运行通路在图像自身色彩空间中处理全分辨率 16-bit 工作表面，并输出调色后的图像与报告。",
    params: {
      format: {
        label: "输出格式",
        hint: "png（默认）或 16-bit tiff；宽色域源两者都保留 16-bit + ICC",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "调色后文件的基础名（空 = <image>_grade）" },
    },
    ports: {
      image: "图像",
      grade_report: "调色报告",
    },
  },
  subjectMask: {
    title: "主体蒙版 / 抠像",
    description:
      "使用确定性的内置工具选取主体并生成蒙版、alpha 图和抠像图：点选、魔棒漫水选择、画笔/橡皮笔触、形态学、填洞与羽化。",
    params: {
      mode: { label: "模式", hint: "手动模式使用已绘制笔触；自动模式使用确定性的内置分割器" },
      wand_tolerance: { label: "魔棒容差", hint: "魔棒漫水选择的颜色距离" },
      grow_px: { label: "扩张 / 收缩 px", hint: "正值膨胀蒙版，负值腐蚀蒙版" },
      fill_holes: { label: "填洞", hint: "羽化前封闭内部封闭空隙" },
      feather_px: { label: "羽化 px", hint: "柔化蒙版边缘（最后应用）" },
      alpha_matting: {
        label: "Alpha 抠像",
        hint: "通过确定性的三分图羽化把二值边缘解算为连续 alpha（头发 / 玻璃）",
      },
      matting_band_px: {
        label: "抠像带宽 px",
        hint: "抠像器解算的三分图未知带宽度（仅在开启 Alpha 抠像时）",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "三件套 PNG 的基础名（空 = <image>_mask）" },
    },
    ports: {
      image: "图像",
      reference: "参考图",
      visual_context: "视觉上下文",
      placeholder_mask: "占位符蒙版",
      previous_mask: "上一蒙版",
      edit_paths: "编辑路径",
      mask: "蒙版",
      alpha_image: "Alpha 图",
      cutout_image: "抠像图",
      trimap: "三分图",
      matte_report: "抠像报告",
    },
  },
  refineMaskEdge: {
    title: "蒙版边缘精修",
    description:
      "清理抠出主体的边缘，使其放入 PSD 占位符时不带白边或杂边：腐蚀/膨胀形态学、引导滤波边缘吸附、羽化与边缘颜色去污。把 Subject Mask 的 `trimap` 输出接进来，可保护其未知带（头发 / 绒毛 / 玻璃的连续 alpha）不被腐蚀/羽化清理破坏，从而保留细节。输出精修图像、精修蒙版与边缘报告。预设会隐藏细节；选 `custom` 可展开全部参数。",
    params: {
      preset: {
        label: "预设",
        hint: "clean = 紧致 1px 收边，natural = 柔和 6px 羽化，soft = 不收边，custom = 展开全部",
      },
      erode_px: { label: "腐蚀 px", hint: "向内收边以去除白边" },
      dilate_px: { label: "膨胀 px", hint: "向外扩张蒙版" },
      feather_px: { label: "羽化 px", hint: "柔化边缘过渡" },
      guided_radius: { label: "引导半径", hint: "将蒙版吸附到亮度边缘（0 关闭）" },
      edge_decontaminate: { label: "边缘去污", hint: "把不透明主体颜色渗入边缘带以消除残余杂边" },
      background_blend_strength: { label: "背景混合", hint: "将边缘带向所连背景色混合" },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "精修 PNG 的基础名（空 = <image>_refined）" },
    },
    ports: {
      image: "图像",
      mask: "蒙版",
      background: "背景",
      placeholder_mask: "占位符蒙版",
      trimap: "三分图",
      refined_image: "精修图像",
      refined_mask: "精修蒙版",
      edge_report: "边缘报告",
    },
  },
  imageEnhance: {
    title: "图像增强",
    description:
      "使用确定性的内置 Lanczos、降噪和锐化路径，把低分辨率主体放大到所需像素尺寸。接入占位符边界可自动定尺，或显式设定目标像素。",
    params: {
      mode: {
        label: "模式",
        hint: "conservative = 温和，texture_rebuild = 强细节，custom = 展开滑块",
      },
      target_width: { label: "目标宽度", hint: "显式目标像素（0 = 由所连边界或预设缩放自动推算）" },
      target_height: { label: "目标高度", hint: "显式目标像素（0 = 由所连边界或预设缩放自动推算）" },
      scale: { label: "缩放", hint: "未给定目标尺寸时的放大倍数" },
      denoise_strength: { label: "降噪", hint: "放大前的边缘保留中值降噪混合" },
      texture_strength: { label: "纹理", hint: "放大后 USM 细节强度" },
      max_pixels: { label: "最大像素", hint: "限制输出像素；缩放会相应降低以适配" },
      preserve_text_logo: { label: "保护文字/logo", hint: "限制锐化，避免 logo / 包装文字被破坏" },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "增强 PNG 的基础名（空 = <image>_enhanced）" },
    },
    ports: {
      image: "图像",
      target_bounds: "目标边界",
      enhanced_image: "增强图像",
      scale_factor: "缩放系数",
      enhance_report: "增强报告",
    },
  },
  detailWatchdog: {
    title: "细节看护",
    description:
      "使用确定性的内置规则扫描候选图像中的模糊、alpha 边缘光晕、颜色不匹配和分辨率不足，并输出 QualityReport。仅检测，不自动重绘。",
    params: {
      mode: { label: "模式", hint: "检测灵敏度：strict = 标记更多，lenient = 标记更少" },
      watch_targets: {
        label: "看护目标",
        hint: "face,hands,text,logo,product_edges 的逗号列表（空 = 全部）；不支持的语义目标会报告为已跳过",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "问题叠加 PNG 的基础名（空 = <image>_issues）" },
    },
    ports: {
      image: "图像",
      visual_context: "视觉上下文",
      target_bounds: "目标边界",
      fixed_image: "修复图像",
      quality_report: "质量报告",
      issue_masks: "问题蒙版",
      watchdog_report: "看护报告",
    },
  },
  detailRepaint: {
    title: "细节重绘",
    description:
      "对 Detail Watchdog 标记的问题区域做局部重绘。为每个可重绘问题（其 suggested_action 在 `Repaint actions` 列表中）带边距裁剪，写出 inpaint 蒙版，将每块裁剪通过 broker 的 image.edit 操作（与 Generate 相同的提供方/凭据路径）发送，再以羽化接缝贴回。输出修复图像与 RepaintReport。若未配置具备编辑能力的提供方（空 / `mock`），则所有区域都不重绘，图像原样通过。",
    params: {
      api_profile_ref: {
        label: "API 配置引用",
        hint: "来自「模型 / API」管理器的托管后端引用（由后端选择器设置）",
      },
      provider: {
        label: "提供方",
        hint: "具备 image.edit 能力的提供方（选择档案时自动设置）；空/mock 则直通",
      },
      operation: { label: "操作" },
      credentials_ref: { label: "凭据", hint: "选择档案时自动设置" },
      repaint_prompt_base: {
        label: "重绘提示词",
        hint: "每个区域的基础提示词（空 = 通用修复提示；问题类型会被追加）",
      },
      repaint_actions: { label: "重绘动作", hint: "要重绘的 suggested_action 值的逗号列表" },
      min_confidence: { label: "最小置信度", hint: "仅重绘置信度达到/高于此值的问题（0..1）" },
      region_padding: { label: "区域边距", hint: "在每个问题框周围添加的上下文边距（px）" },
      max_regions: { label: "最大区域数", hint: "限制重绘的区域数量（优先置信度最高的）" },
      feather_px: { label: "羽化 px", hint: "接缝羽化半径（0 = 按问题尺寸自动）；poisson 混合忽略此项" },
      blend: {
        label: "接缝混合",
        hint: "feather = 补丁接缝处的软 alpha 过渡（默认）；poisson = 梯度域无缝克隆，适合更难的接缝（区域过小时回落 feather）",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: { label: "输出名", hint: "修复图像的基础名（空 = <image>_repainted）" },
    },
    ports: {
      image: "图像",
      quality_report: "质量报告",
      fixed_image: "修复图像",
      repaint_report: "重绘报告",
    },
  },
  videoAssemble: {
    title: "视频合成",
    description:
      "通过媒体引擎内置的原生 FFmpeg 后端将有序的帧图像序列编码为视频文件。连接帧列表（或在 frames 参数中每行填一个路径），选择帧率与编码器，即可在磁盘上得到 .mp4 及编码报告。",
    params: {
      frames: { label: "帧列表", hint: "帧图像路径，每行一个（连接的 frames 输入优先）" },
      fps: { label: "帧率", hint: "输出帧率" },
      codec: { label: "编码器", hint: "ffmpeg 编码器；libx264 兼容性最好" },
      device: {
        label: "设备",
        hint: "gpu 会尝试硬件 H.264 编码器（nvenc/qsv/amf/mf），失败时回退软件编码并显示原因；auto/cpu 使用软件编码",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: {
        label: "输出名",
        hint: "输出文件名（空 = assembled-<时间戳>.mp4；缺省扩展名为 .mp4）",
      },
    },
    ports: {
      frames: "帧列表",
      video: "视频",
      frame_count: "帧数",
      duration_sec: "时长（秒）",
      assemble_report: "合成报告",
    },
  },
  videoTrim: {
    title: "视频剪辑",
    description:
      "通过媒体引擎内置的原生 FFmpeg 后端从视频文件中剪出一个时间区间。连接视频（或在 video 参数中填路径），设置起止秒数，即可得到帧精确的重编码片段及剪辑报告。音频不会保留。",
    params: {
      video: { label: "视频", hint: "源视频路径（连接的 video 输入优先）" },
      start_sec: { label: "起始秒", hint: "剪辑起点（自开头起的秒数）" },
      end_sec: { label: "结束秒", hint: "剪辑终点秒数（0 = 到片尾）" },
      codec: { label: "编码器", hint: "重编码使用的 ffmpeg 编码器；libx264 兼容性最好" },
      device: {
        label: "设备",
        hint: "gpu 会尝试硬件 H.264 编码器（nvenc/qsv/amf/mf），失败时回退软件编码并显示原因；auto/cpu 使用软件编码",
      },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      output_name: {
        label: "输出名",
        hint: "输出文件名（空 = trimmed-<时间戳>.mp4；缺省扩展名为 .mp4）",
      },
    },
    ports: {
      video: "视频",
      frame_count: "帧数",
      duration_sec: "时长（秒）",
      trim_report: "剪辑报告",
    },
  },
  psdExport: {
    title: "PSD 导出",
    description:
      "将生成图像写入 PSD 模板的占位符（尽可能做真正的智能对象替换），并导出 final.psd + preview.png + metadata.json。可接收可选的精修蒙版（作为图像 alpha 应用）以及一个并入导出元数据的生产元数据对象。连接分层资产（智能图层拆分）时，其合成预览可代替图像输入，图层清单（名称、bbox、alpha 引用）会记录到导出的元数据中。",
    params: {
      filename: { label: "文件名" },
      output_dir: { label: "输出目录", hint: OUTPUT_DIR_HINT },
      placeholder: { label: "占位符图层", hint: "要替换的模板图层名（空 = 整张画布）" },
      fit_mode: { label: "适配" },
      smart_object_mode: {
        label: "智能对象",
        hint: "replace_content 重写智能对象（在 Photoshop 中保持可编辑）",
      },
    },
    ports: {
      image: "图像",
      layered_asset: "分层资产",
      template: "模板",
      mask: "蒙版",
      metadata: "元数据",
    },
  },
};

/**
 * Return a copy of `spec` with its human-readable strings translated into
 * `lang`. For `en` (or a kind without an entry) the original spec is returned
 * unchanged; any individual missing string falls back to its English original.
 */
export function localizeSpec(spec: NodeSpec, lang: Lang): NodeSpec {
  if (lang !== "zh") return spec;
  const tr = NODE_ZH[spec.kind];
  if (!tr) return spec;
  return {
    ...spec,
    title: tr.title || spec.title,
    description: tr.description || spec.description,
    inputs: spec.inputs.map((p) => ({ ...p, label: tr.ports?.[p.id] ?? p.label })),
    outputs: spec.outputs.map((p) => ({ ...p, label: tr.ports?.[p.id] ?? p.label })),
    params: spec.params.map((p) => ({
      ...p,
      label: tr.params?.[p.key]?.label ?? p.label,
      hint: tr.params?.[p.key]?.hint ?? p.hint,
    })),
  };
}
