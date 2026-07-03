# Unified Production Drawer Plan

> Status: **第一阶段（下方 1–9）已全部落地**（PR #294–#300）：底部抽屉、
> `ProductionTarget`、Edit/Timeline 工作区、多轨模型、可嵌入 `GradePanel`
> （image + video_clip）、图片/音频右键按需编辑、timeline render plan +
> FFmpeg 导出弹窗。后续方向（音频混音/封装、视频 clip 参与导出、keyframe
> 调色等）尚未排期。

## 目的

这个文档把 H-Gripe Studio 的“大统一”工作区方向固定下来：

- 不是把图片、视频、音频做成几个互不相干的弹窗。
- 不是让视频调色另起一套和图片调色不同的算法。
- 不是把所有东西塞进一个巨型内核。

真正目标是：

```text
node canvas
  -> shared asset / timeline selection model
  -> bottom production drawer
  -> edit/timeline workspace + grade panel
  -> image/audio/specialized editors opened on demand
  -> specialized kernels with clear ownership
```

也就是说，产品体验是一体的；底层可以有多个内核，但每个内核只负责自己该负责的事。

## 核心决定

### 1. 统一工作台：Bottom Production Drawer

底部抽屉只做两个常驻方向：

- 剪辑 / 时间线工作区。
- 调色。

它不是“视频弹窗”，也不是把图片、音频、导出、scopes、inspector 全部常驻进去的大面板。图片处理、音频处理、PSD/mask/crop 等专业编辑器应从剪辑工作区里的 asset / clip 右键按需打开，复用现有独立弹窗或未来的轻量弹出面板。

这样可以保证：用户只是打开底部抽屉看剪辑或调色时，不会顺带启动图片编辑器、音频编辑器、导出器、模型预览、waveform renderer 等不需要的东西。

建议第一层 Tab：

| Tab | 角色 |
| --- | --- |
| Edit / Timeline | 剪辑工作区：media bin、素材工作区、多轨 timeline、clip placement、trim、still-image clip、audio clip |
| Grade | 统一调色面板，编辑当前选中的 image / layer / video clip / node output |

不作为第一层 Tab 常驻：

| 功能 | 打开方式 |
| --- | --- |
| Image Edit / Mask / Crop / PSD Edit | 在 Edit / Timeline 的 image asset、still clip、frame extract、layer reference 上右键打开现有图片处理弹窗 |
| Audio Edit | 在 Edit / Timeline 的 audio clip 或 linked video-audio 上右键打开音频弹窗 |
| Export | 通过 Edit / Timeline 的 render/export command 打开导出弹窗或侧面小面板 |
| Inspector / Scopes | 作为 Edit / Timeline 或 Grade 内部的按需子面板，不是抽屉第一层 |

底部抽屉可以折叠、半高、全高，也可以保留一个轻量 rail/handle。关键不是堆满功能，而是它必须成为剪辑与调色的统一上下文，其他专业工具从当前 selection 按需打开。

### 2. 节点画布仍是源头

节点画布继续负责：

- AI / API / local model 编排。
- 文件源、生成结果、PSD 模板、视频源、音频源。
- 非破坏式 DAG。
- 自动化和批处理。

底部抽屉不替代节点画布。它消费节点画布产生的资产引用，并在剪辑工作区里组织这些资产。用户从 clip / asset 右键打开图片或音频编辑后，确认结果再生成新的非破坏式 output item 或 result node。

### 3. 调色必须共用一个内核

图片处理调色、PSD/layer 调色、视频 clip 调色、节点输出调色，都应该使用同一个 `hgripe-grade` 数学内核。

视频只是在调色参数外面增加：

- 时间轴目标。
- clip selection。
- keyframe interpolation。
- frame cache / preview。
- export renderer。

它不应该 fork 出另一套“视频颜色系统”。

### 4. 音频可以是独立内核

音频的处理对象、缓存方式、实时性和导出链路都不同，所以可以有独立的 audio kernel。

但音频不能成为独立产品孤岛。它必须接入同一个：

- Edit / Timeline 工作区。
- timeline model。
- selection context。
- export graph。
- undo/history。

## 内核分工

### `hgripe-grade`

负责：

- f32 grade surface。
- exposure / contrast / levels / curves / HSL / LUT / wheels。
- scopes 相关计算。
- image 和 video 使用同一套 op graph。
- keyframe interpolation 所需的可序列化参数模型。

不负责：

- ICC 解析。
- 文件读写。
- timeline clip 调度。
- audio。
- API 调用。

### Colour / WorkingImage pipeline

负责：

- ICC / CMYK / YCCK / TIFF / ProPhoto / sRGB egress。
- `WorkingImage` 和 `GradeSurface` 的 ingress / egress。
- API/model 边界的 sRGB 8-bit egress。

不负责：

- 调色 UI 状态。
- timeline。
- audio。

### Media / Timeline kernel

负责：

- media asset registry。
- 多轨 timeline。
- clip placement / trim / split / ripple 或非 ripple 策略。
- image still clip。
- video clip。
- audio clip。
- playhead / selection / snapping。
- keyframes。
- timeline render plan。

不负责：

- 调色数学。
- PSD 文件格式。
- 音频 DSP 细节。

### Image Edit kernel

负责：

- mask / crop / matte / pen / lasso / brush / PSD layer 编辑。
- 现有图片编辑弹窗或面板的核心状态。
- 把手工编辑结果写回非破坏式 image output。

它可以调用 `hgripe-grade` 做颜色，但不应该自己维护另一套调色算法。

### Audio kernel

负责：

- audio decode。
- waveform overview。
- audio trim。
- gain / normalize / fade in / fade out。
- clip-level effects。
- 多轨 mix。
- 和 video export 的 mux。

第一版不需要变成完整 DAW。先实现剪辑产品需要的音频闭环。

### Render / Export kernel

负责：

- timeline render plan。
- video frame sequence render。
- audio mixdown。
- FFmpeg encode / mux。
- still image / PSD / video / audio export。

它消费 timeline、grade、image edit、audio kernel 的结果，不重新实现它们。

## 统一 Target 模型

底部抽屉本身只需要知道当前剪辑/调色 selection。专业弹窗也围绕同一个 selection target 工作，但它们是按需打开的，不随抽屉常驻。

```ts
type ProductionTarget =
  | { kind: "asset"; assetId: string }
  | { kind: "image"; assetId: string; sourceNodeId?: string }
  | { kind: "image_layer"; workspaceId: string; layerId: string }
  | { kind: "video_clip"; timelineId: string; trackId: string; clipId: string; frame?: number }
  | { kind: "audio_clip"; timelineId: string; trackId: string; clipId: string; time?: number }
  | { kind: "node_output"; nodeId: string; outputPort?: string }
  | { kind: "timeline"; timelineId: string };
```

底部抽屉和按需弹窗都不应该问“我是图片弹窗还是视频弹窗”。它们应该问：

```text
当前 target 是什么？
这个 target 支持哪些 operations？
确认后输出到哪里？
```

## 关键交互

### 从节点到剪辑工作区

- 拖 image node output 到 Edit / Timeline 工作区：成为 image asset。
- 拖 video source 到 Edit / Timeline 工作区：成为 video asset。
- 拖 audio source 到 Edit / Timeline 工作区：成为 audio asset。
- 拖 image 到 timeline track：创建 still-image clip。
- 拖 video 到 timeline track：创建 video clip。
- 拖 audio 到 timeline track：创建 audio clip。

工作区/bin drop 只入库；timeline track drop 才直接放入时间线。

### 图片右键编辑

在 Edit / Timeline 工作区里的 image asset / still clip / extracted frame / layer reference 上右键：

- Open Image Edit。
- Open Mask Edit。
- Crop / Transform。
- Grade。

这些应该优先复用现有独立图片处理弹窗。后续如果要嵌入，也应作为按需 overlay / secondary panel，而不是底部抽屉第一层常驻 Tab。

确认后：

- 原 asset 不被覆盖。
- 生成新的 edited asset 或 bound result node。
- 如果来源是 timeline clip，可以选择替换该 clip 的 media reference，或新增 take/version。

### 视频 clip 右键编辑

在 Timeline 的 video clip 上右键：

- Trim / Split。
- Open Grade。
- Extract frame as image asset。
- Send current frame to Image Edit。
- Replace clip media with processed output。

视频调色打开的是同一个 `Grade` Tab，只是 target 是 `video_clip`。

### 音频 clip 右键编辑

在 Timeline 的 audio clip 上右键：

- Open Audio Edit。
- Trim。
- Gain。
- Fade in / out。
- Normalize。
- Detach / relink from video。

音频编辑打开按需音频弹窗。结果进入 timeline audio track 和 export mix，不走图片/调色内核。

### 两个常驻 Tab，不做全量启动

底部抽屉的常驻 Tab 只有剪辑和调色。推荐状态：

```text
selected target = video clip

Edit / Timeline tab:
  显示 media workspace、timeline、clip selection、右键菜单

Grade tab:
  编辑这个 clip 的 GradeDoc / keyframes

Right-click image/still/frame:
  按需打开现有 Image Edit / Mask / Crop 弹窗

Right-click audio clip:
  按需打开 Audio Edit 弹窗

Export command:
  按需打开 export dialog / render panel
```

抽屉打开时只初始化剪辑工作区和必要的调色面板状态。图片编辑器、音频编辑器、导出器、模型预览、复杂 scopes 都应 lazy mount。

## 与现有文档的关系

### `DUAL_DOCK_WORKSPACE_PLAN.md`

保留其中关于：

- graph canvas 作为 source of truth。
- left image/PSD workspace。
- right video/timeline workspace。
- bottom drawer option。
- drag-to-rail inbox。

但方向应从“左右两个 dock”升级为：

```text
one production drawer + optional side handles
```

左右 rail 可以继续存在，但它们只是快速入口和 drop target，不是两个独立产品。

### `docs/design/grade-kernel.md`

继续作为调色内核的数学和 determinism 合同。

本文件强调：`hgripe-grade` 的宿主不止 image grading dialog，也包括 timeline clip grading。

### `docs/cards/generic-media-card.md`

继续作为 media card / bound result node 的图模型合同。

本文件补充：同一个 media asset 还可以进入 Edit / Timeline 工作区，并从那里右键打开按需编辑弹窗。

### `docs/design/editor-resource-model.md`

继续作为资源、线程、preview/render/playback lane 的工程合同。

本文件补充：音频 kernel 和 timeline kernel 也必须声明自己的 lane，不要阻塞 UI 或抢占 GPU compute。

## 第一阶段实现顺序（已全部落地，PR #294–#300）

1. ✅ 新增底部 `ProductionDrawer` shell。(#294)
2. ✅ 新增统一 selection context：`ProductionTarget`。(#294)
3. ✅ 新增 `Edit / Timeline` Tab，内部包含轻量 media workspace / bin。(#294)
4. ✅ 新增最小多轨模型：image still clip、video clip、audio clip。(#295)
5. ✅ 把现有 `GradeEditModal` 抽成可嵌入的 `GradePanel`，保留 modal wrapper。(#296)
6. ✅ `GradePanel` 支持 `image` 和 `video_clip` 两种 target。(#297)
7. ✅ 图片右键从 Edit / Timeline 工作区打开现有 Image/Mask/Crop 编辑弹窗。(#298)
8. ✅ 音频右键按需打开 waveform + trim + gain + fade 的最小弹窗。(#299)
9. ✅ Export command 消费 timeline render plan，按需打开导出弹窗并调用 FFmpeg encode/mux。(#300)

## 非目标

- 第一版不做完整 DAW。
- 第一版不做完整 Premiere。
- 第一版不重写所有图片编辑器。
- 第一版不删除节点画布。
- 第一版不让视频调色绕开 `hgripe-grade`。
- 第一版不让音频逻辑混进图片/调色内核。
- 第一版不把 Image Edit、Audio Edit、Export、Inspector 全部做成底部抽屉常驻 Tab。

## 成功标准

当以下流程可以在一个工作台内闭环，才算“大统一”真正成立：

1. 从节点画布生成一张图片。
2. 将图片拖入 Edit / Timeline 工作区。
3. 将图片拖入 timeline 作为 still clip。
4. 右键 still clip 打开 Image Edit 修图。
5. 直接切到 Grade Tab 用同一个 `hgripe-grade` 调色。
6. 拖入视频 clip，使用同一个 Grade Tab 调色。
7. 拖入音频 clip，右键打开 Audio Edit 弹窗做 trim/gain/fade。
8. Export command 打开导出弹窗，导出带音频的视频。
9. 原始节点和原始 asset 都不被破坏，所有确认操作产生可追溯 output。

这就是 H-Gripe Studio 应该追求的一体化：底部抽屉常驻剪辑与调色，专业编辑器按需打开；一个生产上下文，多种专业内核，统一资源、统一时间线、统一导出。
