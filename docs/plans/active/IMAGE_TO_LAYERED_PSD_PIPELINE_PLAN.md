# Image to Layered PSD Pipeline Plan

## 目标

这份文档单独固定“普通图片转可编辑分层资产，再进入 PSD/节点生产链”的方向。

用户多数时候不会一开始就有 PSD。更常见的入口是：

```text
drag image into canvas
  -> automatic layer split
  -> open editor for review / correction
  -> confirm layered asset
  -> send layers / masks / composite to model, grade, timeline, or PSD export
```

这条链路的价值不是把 JPG/PNG 神奇还原成原始 Photoshop 文件，而是把扁平图片转换成可以继续生产的结构化资产。

## 核心判断

普通图片只有最终像素，没有原始图层历史。因此系统不能承诺：

- 还原设计师原始 PSD 图层。
- 还原所有文字、智能对象、调色层、组结构、样式、混合模式。
- 还原被遮挡区域的真实内容。
- 自动一次性得到完美可编辑 PSD。

系统应该承诺的是：

- 自动识别画面中的主体、背景、物体、文字、阴影、遮挡、边缘区域。
- 生成可编辑 layer candidates。
- 为每个 layer candidate 生成 mask、bbox、confidence、semantic label。
- 打开现有图片/PSD 编辑器让用户确认、修边、合并、拆分、重命名。
- 确认后得到稳定的 layered asset，供下游节点使用。
- 需要时导出为 PSD/PSB 的生产子集。

一句话：

```text
not "restore original PSD"
but "convert flat image into editable production layers"
```

## 产品位置

图片转分层不应该是一个孤立工具，也不应该藏在顶层 Tab 里。它应该是节点画布里的一个可组合能力。

推荐入口：

- 拖入图片后，右键图片节点选择 `Split to Layers`。
- 图片节点输出接入 `Smart Layer Split` 节点。
- 在图片编辑器里打开 `Review Layers`。
- 在 Edit / Timeline 工作区的 image asset 上右键打开分层。
- 在本地模型节点之前自动插入分层节点，作为可选预处理。

推荐节点链：

```text
Image Source
  -> Smart Layer Split
  -> Layer Review / Mask Edit
  -> Layered Asset
  -> Local Model / API Model / Grade / Composite / Timeline / PSD Export
```

## 为什么它比“图片 + 文本”更强

单张图片加提示词只有像素和语言意图。模型需要猜：

- 要改哪里。
- 哪些区域不能动。
- 物体边界在哪里。
- 背景和主体如何分离。
- 文字是否要保留。
- 阴影是否属于主体。

分层资产给模型更多结构：

- 目标层。
- mask。
- 去掉目标层后的背景近似。
- layer bbox。
- layer name / semantic label。
- alpha / matte。
- 参考层。
- 合成预览。

因此下游模型节点可以更明确地工作：

```text
edit target = product layer
protect = text layer + face layer
context = background composite
mask = product alpha
prompt = "change product color to matte black"
```

这会比把整张图丢给模型再写一大段 prompt 稳定得多。

## 分层资产模型

内部不应该一开始就把结果等同于 PSD 文件。推荐先定义项目内的 `LayeredImageAsset`，PSD 只是导入/导出格式之一。

```ts
type LayeredImageAsset = {
  id: string;
  sourceAssetId: string;
  sourceNodeId?: string;
  canvas: {
    width: number;
    height: number;
    colorSpace: "srgb" | "display-p3" | "unknown";
  };
  baseImage: ImageRef;
  previewComposite: ImageRef;
  layers: LayerCandidate[];
  splitReport: LayerSplitReport;
};

type LayerCandidate = {
  id: string;
  name: string;
  kind:
    | "subject"
    | "background"
    | "object"
    | "person"
    | "face"
    | "hair"
    | "clothing"
    | "product"
    | "text"
    | "logo"
    | "shadow"
    | "reflection"
    | "sky"
    | "foreground"
    | "unknown";
  bbox: [number, number, number, number];
  mask: ImageRef;
  rgba?: ImageRef;
  confidence: number;
  source: "model" | "algorithm" | "user" | "mixed";
  visible: boolean;
  locked?: boolean;
  notes?: string[];
};

type LayerSplitReport = {
  engineVersion: string;
  createdAt: string;
  warnings: string[];
  suggestedReview: ReviewIssue[];
};
```

注意：

- `mask` 是必须项。
- `rgba` 可以延迟生成，避免大图一开始就吃内存。
- `source` 要标记这层来自自动分割、用户修正，还是混合结果。
- `confidence` 决定 UI 是否提示用户必须检查。
- `splitReport` 保留诊断信息，方便后面重跑和对比。

## 计算引擎分工

图片转分层应该是多阶段管线，不是单个万能模型。

### Stage 1: 图像预处理

目标：

- 读取图像尺寸、颜色空间、EXIF orientation。
- 生成低分辨率预览。
- 建立原图到预览图的坐标映射。
- 生成边缘图、显著性图、粗略深度图。

输出：

- normalized image。
- preview pyramid。
- working color space。
- basic analysis metadata。

### Stage 2: 粗分割

目标：

- 主体/背景分离。
- 多实例物体分割。
- 人像区域识别。
- 产品/前景物体识别。
- 天空/地面/墙面等大区域识别。

可用能力：

- 本地轻量分割模型。
- ONNX / `ort` 路线优先，避免重新把 Python/Torch 放回核心路径。
- 传统算法辅助边缘、连通区域、显著性。

输出：

- raw masks。
- candidate bboxes。
- candidate labels。
- confidence。

### Stage 3: 语义理解和命名

目标：

- 给每个候选层命名。
- 判断层类型。
- 给出建议拆分/合并。
- 识别可能的文字、logo、产品、人物、衣服、头发、阴影。

实现策略：

- 本地小模型可做基础分类。
- 云端/外部多模态模型可以作为可选增强。
- 模型建议只作为 metadata，不直接破坏原始 mask。

输出示例：

```json
{
  "id": "layer_product_01",
  "name": "product bottle",
  "kind": "product",
  "confidence": 0.88,
  "suggestions": ["check transparent edge", "keep shadow as separate layer"]
}
```

### Stage 4: Mask 精修

目标：

- 修边。
- 处理头发、半透明、玻璃、投影、反光。
- 清理锯齿和孔洞。
- 生成 soft matte。

建议：

- 第一版重点做主体、产品、背景。
- 头发、透明、反光属于高风险区域，必须提示人工检查。
- 不要让自动精修覆盖用户已确认的 mask。

### Stage 5: 背景近似和遮挡补全

目标：

- 对于被移除目标层后的背景，生成一个可用的 context。
- 给模型节点提供 `background_without_target`。

注意：

- 这不是原始背景，只是 inpaint/clone/blur 得到的近似。
- 必须标记为 synthetic。
- 下游导出 PSD 时不要伪装成真实原始背景层。

### Stage 6: 用户确认

目标：

- 打开图片/PSD 编辑器进行确认。
- 让用户看到每层、mask、bbox、confidence、问题提示。
- 用户可以快速修边、合并、拆分、重命名、删除、锁定。

确认后才生成正式 `LayeredImageAsset`。

## Review Editor 交互

自动分层后必须进入人工确认环节。否则错误层会污染后续节点。

建议 UI：

- 左侧 layer list。
- 中央 canvas 显示合成预览。
- 右侧属性/问题提示。
- layer list 显示 confidence 和 warning。
- 低置信层显示醒目标记。
- 一键查看 mask overlay。
- 一键 solo layer。
- 一键查看 removed background。

必要操作：

- Rename layer。
- Merge layers。
- Split layer by lasso / brush / model assist。
- Refine mask。
- Paint mask。
- Erase mask。
- Expand / contract mask。
- Feather。
- Delete layer。
- Lock protected layer。
- Mark as text / product / person / background。
- Confirm asset。

不要把 Review Editor 做成新的顶层产品入口。它应该复用现有图片/PSD 编辑弹窗或未来按需 overlay。

## 和节点系统的关系

`Smart Layer Split` 节点应该输出多种端口，而不是只输出一个 PSD 文件。

推荐端口：

```text
image_in

outputs:
  layered_asset
  composite_preview
  subject_layer
  background_layer
  masks
  split_report
```

下游节点可以消费：

- `layered_asset`：完整分层资产。
- `layer_id + mask`：局部模型编辑。
- `composite_preview`：预览/调色。
- `background_without_target`：重绘上下文。
- `split_report`：质量检查和自动路由。

示例：

```text
Image Source
  -> Smart Layer Split
  -> Select Layer(kind = product)
  -> Local Inpaint Model
  -> Composite Layers
  -> Grade
  -> Export PSD
```

## 和本地模型节点的关系

本地模型节点不应该只吃 `image + prompt`。它应该支持结构化输入。

推荐输入：

```ts
type ModelEditInput = {
  composite: ImageRef;
  targetLayer?: LayerRef;
  targetMask?: ImageRef;
  backgroundContext?: ImageRef;
  protectedMasks?: ImageRef[];
  prompt: string;
  negativePrompt?: string;
  semanticHints?: string[];
};
```

这样可以做：

- 只改人物衣服。
- 只换产品颜色。
- 只清理背景。
- 保留文字和 logo。
- 用背景上下文补齐被遮挡区域。
- 生成结果回写为新 layer，而不是覆盖原图。

## 下一步优先级：协议桥接 PR

下一步不要直接进入完整自动分层算法。先打通 `LayeredImageAsset`、统一
selection target 和节点端口，让 UI、节点画布、Review Editor、Grade、Timeline
先能引用同一份分层资产。

这个 PR 的目标是：

- 定义 `LayeredImageAsset` / `LayerCandidate` / `LayerSplitReport` 的
  TypeScript 类型。
- 在统一 selection 模型里加入：

```ts
type ProductionTarget =
  | { kind: "layered_image"; assetId: string; sourceNodeId?: string }
  | { kind: "image_layer"; assetId: string; layerId: string; workspaceId?: string };
```

- 给节点端口增加：

```text
outputs:
  layered_asset
  composite_preview
  selected_layer
  masks
  split_report
```

- 做一个最小 `Smart Layer Split` stub：先输出 original locked layer、
  background candidate、subject candidate，mask 可以先用占位或简单算法。
- Review Editor 先消费这个 stub asset，验证 layer list、mask overlay、
  confirm asset、layer id 引用是否跑通。
- 模型节点、Grade、Timeline 暂时只需要能识别 `layered_asset` 和
  `image_layer` target，不需要立即完成真实模型分层。
- 所有确认后的编辑结果必须生成新 layer 或新 asset version，不覆盖原图。

验收标准：

- 图片节点可以产生一个 `layered_asset` 输出。
- UI 可以选中整个 `layered_image` 或某个 `image_layer`。
- `ProductionTarget` 能承载 layer 选择，不依赖某个弹窗是否打开。
- `image_layer` 可以进入 Grade 或模型节点的输入协议。
- Timeline still clip 可以引用 `layered_image` 的 composite preview。
- PSD export 可以看到分层资产，但第一版只要求基础层名、bbox、alpha。

这个协议桥接 PR 完成后，后续再替换真实分割、语义命名、mask refinement、
背景近似和 PSD/PSB 导出细节。

## 和 PSD 的关系

PSD 在这条链里有两个角色：

1. 输入格式：用户直接拖入 PSD 时，读取真实图层。
2. 输出格式：用户从分层资产导出 PSD/PSB。

普通图片转分层后导出的 PSD 应该带清楚的结构：

```text
Generated Layers/
  product bottle
  product shadow
  background approximation
  text region
  original image locked
Reports/
  split report metadata
```

建议保留一个锁定的 `original image` 层，方便用户随时对照原图。

不建议第一版支持完整 Photoshop 高级特性：

- smart object。
- adjustment layer round-trip。
- complex layer styles。
- advanced blend modes。
- vector text editable round-trip。
- exact Photoshop group behavior。

第一版 PSD 导出目标：

- 图层名称。
- 图层顺序。
- 图层透明度。
- 基础 alpha。
- 基础 bbox。
- 原图锁定层。
- 合成预览尽量接近。

## 和 Rust / Python 退场的关系

这条链路很容易把 Python/Torch 重新拖回来，所以必须提前限定边界。

短期可以接受：

- Python 作为研究/离线实验。
- Python 作为 golden fixture 生成工具。
- Python 作为可选外部插件。

不应该接受：

- 默认桌面运行依赖 Python。
- Tauri 命令固定 shell out 到 Python 做分层。
- 把 ComfyUI/Torch 作为核心分层必需依赖。

推荐路线：

- Rust 管理 asset、mask、bbox、job、cache、PSD export。
- Rust 调用 ONNX Runtime / native model backend 做轻量分割。
- 云端或外部模型只作为可选增强。
- Python 不回到核心桌面 runtime；如需研究、golden fixture 或重模型实验，
  只能作为外部工具/插件边界存在。

这和 [`PYTHON_TO_RUST_MIGRATION_PLAN.md`](../completed/PYTHON_TO_RUST_MIGRATION_PLAN.md)
的原则一致。

## 和 GPU / 设备策略的关系

图片转分层第一版不应该强依赖特定 GPU。

短期：

- CPU 可跑。
- 大图自动降采样预览。
- 确认时再生成高分辨率 mask。
- 设备报告只说明当前可用能力。

中期：

- ONNX / native backend 支持 GPU 时自动启用。
- 用户可看到当前任务使用 CPU / GPU。
- 不同设备输出要有容忍范围测试。

长期：

- 分层、mask refinement、matting、inpaint、preview 可以进入统一 device manager。
- 但节点协议不应该暴露 CUDA / DirectML / Metal / Vulkan 细节。

## 短期实现路径

### Phase 0: 固定协议

目标：先确定数据模型，不急着做完美算法。

任务：

- 定义 `LayeredImageAsset`。
- 定义 `LayerCandidate`。
- 定义 `LayerSplitReport`。
- 定义节点端口。
- 定义 Review Editor 的确认输出。
- 加最小 fixture。

成功标准：

- 一张图片可以被包装成 layered asset。
- 至少包含 original locked layer 和 background/subject candidates。
- 下游节点可以按 layer id 引用。

### Phase 1: 主体/背景分离

目标：做最小可用闭环。

任务：

- 图片输入。
- 自动主体 mask。
- 背景层。
- Review Editor 显示 mask。
- 用户确认。
- 输出 layered asset。

成功标准：

- 用户能拖入图片，自动得到主体/背景。
- 用户能修 mask。
- 确认后能进入模型节点或导出基础 PSD。

### Phase 2: 多物体实例分层

目标：从“主体/背景”升级到“可选物体层”。

任务：

- 多实例分割。
- layer list。
- 自动命名。
- 合并/拆分。
- low-confidence warning。

成功标准：

- 产品图、人像图、简单海报图可以拆出多个可用对象。
- 模型节点可以选择某一层作为 target。

### Phase 3: 文字、logo、阴影

目标：面向设计图和电商图。

任务：

- text region detection。
- logo / brand region 标记。
- shadow candidate。
- reflection candidate。
- protected layer 标记。

成功标准：

- 改产品/背景时可以保护文字和 logo。
- 阴影可以单独保留或重新生成。

### Phase 4: PSD/PSB 导出生产子集

目标：让确认后的 layered asset 能交给外部软件或回到 H-Gripe 工程。

任务：

- 导出基础 PSD。
- 保留 original locked layer。
- 保留 generated layer group。
- 写入 split metadata。
- 生成 composite preview。

成功标准：

- Photoshop / Photopea / Affinity 能打开基础图层。
- 图层名称、顺序、透明区域正确。
- H-Gripe 再导入能识别 metadata。

### Phase 5: 视频帧和时间线接入

目标：让视频工作流也能使用分层。

任务：

- ✅ 从视频提取 still image：`smartLayerSplit` 增加 `video` 输入端口 +
  `frame_sec` 参数，桌面运行时通过媒体引擎解码最接近的静帧后再拆分，
  静帧写入输出目录并记录在 split report 里。
- ✅ 对当前帧做分层：提取的静帧走完整的主体/背景/实例/文字/logo/
  阴影/反光管线，`source_asset_id` 指向源视频。
- ✅ 时间线右键入口：video / still clip 的右键菜单提供 `Split to layers`，
  在节点画布上生成接到该 clip 素材（复用来源卡片，否则按素材路径新建）的
  Smart Layer Split 卡片并选中它，分层结果回到 Review 面板与下游节点。
- 后续再考虑对象跟踪和跨帧 mask。

成功标准：

- 用户可以从视频帧右键生成分层图片。
- 分层结果可以被图片编辑器、调色、模型节点消费。

## 长期方向

长期可以发展成真正的生产级分层系统：

- 人像细分：头发、脸、皮肤、衣服、手部、饰品。
- 产品细分：主体、标签、瓶盖、阴影、反光、背景。
- 海报细分：文字、logo、主体、装饰、背景。
- 自动生成 prompt hints。
- 自动判断哪些层应该保护。
- 分层结果跨节点复用。
- 分层结果进入 timeline still clip。
- 视频对象跟踪后形成 temporally consistent masks。
- 分层导出 PSD/PSB。
- 分层工程文件长期兼容。

## 质量标准

必须测试：

- 人像图。
- 产品图。
- 带文字海报。
- 透明/玻璃物体。
- 复杂背景。
- 低分辨率图。
- 大图。
- 带 EXIF rotation 的图。
- 非 sRGB 或未知色彩空间图。

质量指标：

- 主体 mask 可用率。
- 用户平均修正时间。
- low-confidence 提示是否命中真实问题。
- 下游模型编辑是否比整图 prompt 更稳定。
- 导出 PSD 是否可打开。
- H-Gripe 再导入是否保留 metadata。

## 风险

### 风险 1: 用户误以为能还原原始 PSD

解决：

- UI 和文档使用 `Smart Layers` / `Generated Layers`。
- 不使用“还原原始 PSD”这类措辞。
- 导出的 PSD 保留 original locked layer 和 generated metadata。

### 风险 2: 自动分层错误污染后续节点

解决：

- 强制 Review Editor。
- low-confidence warning。
- 未确认 layered asset 不进入正式下游。

### 风险 3: Python/Torch 重新成为默认依赖

解决：

- 核心协议和 job 在 Rust。
- 模型后端优先 ONNX/native。
- Python 只做实验和 parity oracle。

### 风险 4: 大图内存爆炸

解决：

- preview pyramid。
- mask 延迟高分辨率化。
- rgba layer 延迟生成。
- job cache 有尺寸限制。

### 风险 5: PSD 导出范围失控

解决：

- 第一版只做生产子集。
- 高级 Photoshop 特性明确非目标。
- H-Gripe 内部以 `LayeredImageAsset` 为主，不以 PSD 为唯一真相。

## 非目标

第一阶段不做：

- 完整 Photoshop PSD round-trip。
- 完整文字可编辑还原。
- 完整智能对象还原。
- 完整图层样式还原。
- 视频全自动对象跟踪。
- 一键完美分层。
- 默认依赖 Python/Torch。
- 把 Review Editor 做成新的顶层 Tab。

## 成功闭环

当下面流程可以稳定走通时，这条路线就成立：

1. 用户把 JPG/PNG 拖到节点画布。
2. 系统创建 image source node。
3. 用户运行或右键执行 `Smart Layer Split`。
4. 系统生成 layer candidates。
5. 自动打开或提示打开 Review Editor。
6. 用户修正并确认层。
7. 系统生成 `LayeredImageAsset`。
8. 用户选择某一层进入本地模型节点。
9. 模型结果作为新 layer 回写。
10. 用户进入 Grade 或 Timeline。
11. 最终导出图片、PSD 或视频。

这条链路会把 H-Gripe Studio 和普通“图片 + prompt”画布拉开距离：画布负责组织生产流，Rust 内核负责可追踪资产和处理，下游模型消费结构化层，而不是盲猜整张图。
