# 图片编辑器内部梳理：文件职责 / 数据链路 / 风险 / 短路

范围：`apps/desktop-tauri/studio-ui/src/editor` 中围绕图片编辑器（MaskEditModal / MediaEditModal 一带）的部分。基于 main（PR #588 合并后；进展记录见文末第六节，最后更新于 PR #592 合并后）。

---

## 一、文件职责分层

### 1. 文档模型层（纯数据，无 React / 无副作用）
| 文件 | 职责 |
|---|---|
| `types/production.ts` | 冻结的存储契约：`MaskDocument` v3、`MaskLayer`、`EditOp`、`LayerMask`、`LayerTargetKind` 等，写进节点 `edit_paths` 参数的就是这个 |
| `maskEdit.ts` (727 行) | 编辑状态核心：`EditState`（current + past/future 撤销栈，上限 100）＋所有纯变更函数（加层/删层/加蒙版/改混合/加笔画/加操作/undo/redo）＋ `normalizeEditPaths`（v1/v2/v3 迁移） |
| `imageDocument.ts` | K1 图像文档模型：`ImageDocument`（像素层/调整层/组），与 `MaskDocument` 的无损双向桥（`fromMaskDocument` / `toMaskDocument`） |
| `imageAdjustments.ts` | u8 调整（levels/curve/…）→ 灰度核 f32 `GradeOp` 的翻译 |
| `imageCompile.ts` | K2：`ImageDocument` 调整栈编译为 `GradeDoc`，走 grade kernel 渲染（像素合成仍留在 mask 执行器，K4 未做） |
| `gradeKernel/*` | 第二像素核（TS 镜像 + Rust `hgripe-grade`）：ops/blend/lut/spline/scopes |

### 2. 工具与预览层
| 文件 | 职责 |
|---|---|
| `maskTools.ts` + `maskToolsI18n.ts` | 工具注册表（paint/click/point/matte/global/marquee/transform/path…），PS 槽位，`planned` 工具置灰 |
| `maskMorphology.ts` (1317 行) | 前端**近似**形态学预览：小尺寸 proxy alpha buffer 上做 grow/shrink/feather/smooth，纯函数、advisory only、永不写回 |
| `maskEditModal/stagePainter.ts` | 纯 canvas 绘制函数：笔画带、路径、SAM 点、选框、快速蒙版等（无 React 状态） |
| `maskEditModal/pathGeometry.ts` / `magneticSnap.ts` / `pathEditTools.ts` | 矢量路径几何、磁性吸附、锚点编辑 |

### 3. UI 壳层
| 文件 | 职责 |
|---|---|
| `MaskEditModal.tsx` (**2552 行 / 112KB**，#590–#592 后已减至 1772 行) | 编辑器壳：指针事件→图像坐标、场景组装、underlay 管理、PreviewLane、面板编排、快捷键——最大单文件 |
| `maskEditModal/pointerMachine.ts` + `pointer/*` (12 个子模块) | 指针状态机（#590/#591 拆出）：`pointerDown/Move/Up` 只做门禁与手势优先级分发，各工具类型（navigation/pathEdit/path/brush/patch/crop/marquee/transform/gradient/shape/clickTools）一模块 |
| `maskEditModal/useCropTool.ts` / `CropPanel.tsx` / `MarqueeSizePanel.tsx` | 裁剪工具状态簇与两个浮动画布面板（#592 拆出） |
| `maskEditModal/actions.ts` | reducer：把 `maskEdit.ts` 的纯函数收拢成一个 action 分发面，壳和面板共用 |
| `maskEditModal/LayersPanel.tsx` 等面板 | PS 式面板（图层行=眼睛/内容缩略图/链接/蒙版缩略图/名称、历史、通道、调整、路径、信息、工具选项） |
| `maskEditModal/MaskStage.tsx` | 中央舞台展示：underlay 帧 + 编辑 canvas 叠一个文档空间 frame；`baseHidden` 隐藏底图显示棋盘格（之前修的 bug 就在这条 prop 链上） |
| `MediaEditModal.tsx` | 统一图片编辑器：一个工具组切换器下托管 mask/crop 编辑器，带文档 tab 条 |
| `host/EditorHost.tsx` | 软件级编辑器宿主：只认 `EditorTarget`（imagePath/nodeId/title）+ commit 回调，对节点/图一无所知；code-split 懒加载 |

### 4. Agent / Action 层
| 文件 | 职责 |
|---|---|
| `studioTarget.ts` | 一等目标 id（layer/mask/selection…）与解析器 |
| `computeBlocks.ts` | 计算块注册表（SAM 2 point prompt 已接真实 Rust `sam2_prompt_mask`） |
| `studioAction.ts` | dry_run → preview → commit 事务；commit 落到 `EditState` 普通撤销步 |
| `studioAgent.ts` | agent 边界：只允许白名单 action id 的提案，用户确认后才 commit |

---

## 二、数据链路

### 主链（真实数据，落盘）
```
节点 edit_paths(JSON) → normalizeEditPaths(v1/v2/v3 迁移) → EditState.current
  → 用户操作 / studioAction commit → maskEdit 纯函数 → 新快照入 past（撤销栈）
  → onDocChange（草稿，跨 tab 保活） / onCommit → 写回节点参数
  → 运行时 Rust 后端按层重放 ops 栈并合成（权威栅格化）
```
前端**从不**产出最终像素；文档记录的是"意图"（ops 栈），后端 run 时重放。

### 预览链（三条，全 advisory）
1. **Underlay**：viewport host 渲染的帧窗口（native surface swap 时 webview 留洞），缩放静置 120ms 后按新窗口细节重渲；`imageTransform` 只作为 CSS 变换叠加。
2. **Overlay canvas**：`stagePainter` 画笔画带/路径/选框——只是视觉提示，软笔刷用 CSS blur 近似，注释明确"proxy/后端 stamp 才是权威软栅格"。
3. **Proxy 形态学**：`maskMorphology` 在缩小的 alpha buffer 上近似 grow/shrink/feather，`PreviewLane` latest-wins，永不写回。

### 图像工作区支线（K1/K2）
```
MaskDocument --fromMaskDocument--> ImageDocument（编辑用，超集）
ImageDocument --toMaskDocument--> MaskDocument | null（不可桥接返回 null）
ImageDocument 调整栈 --imageCompile--> GradeDoc --applyDoc/hgripe-grade--> 预览
```

---

## 三、风险点

1. **MaskEditModal.tsx 是 2552 行的 god component**。指针状态机（十几种工具 kind）、underlay 生命周期、PreviewLane、场景组装、面板编排都在一个文件里。每次加工具都往里堆；隐藏按钮那类 bug（状态改了但某条渲染链没消费）正是这种结构的典型产物。已拆出 stagePainter/actions/面板，但指针状态机和场景组装仍未拆。
2. **双文档模型并存，且桥是"可失败"的**：`toMaskDocument` 对组/剪贴蒙版/grade ops/非 mask 混合返回 `null`。当前靠"图像工作区只产出可桥接文档"这一约定保证 commit 不丢——约定没有类型或运行时护栏，K2/K4 推进时最易踩。可桥接混合模式是硬编码字符串数组（`imageDocument.ts:168`），与 `LAYER_BLENDS` 无单一来源。
3. **预览与权威栅格的漂移**：三条预览链都是近似（CSS blur 软笔刷、proxy 形态学、CSS 变换 move）。设计上刻意如此（防前端复刻 Rust 形态学导致状态漂移），但意味着"预览看着对、run 出来不对"类 bug 只能靠后端 golden test 兜底；目前 golden 只覆盖 gradeKernel。
4. **无图可解码时的默认坐标系**：浏览器预览下常无缩略图，编辑记录在 960×640 默认空间（`DEFAULT_W/H`），后端按真实图栅格化。若真实尺寸比例不同，浏览器预览里录的笔画位置会系统性偏移——mock 环境的已知坑，但没有显式警告。
5. **normalizeEditPaths 静默丢弃**：畸形 layer 直接 filter 掉、全丢则补空背景层。宽容加载是对的，但用户不会知道文档被裁剪过（无任何提示/日志）。
6. **调整层双表示**：`{ adjustment?: LayerAdjustment; ops?: GradeOp[] }` "恰好其一"只靠注释约束，类型上两者可同时存在或同时缺失。
7. **撤销栈快照整文档**：MAX_HISTORY=100 份 `MaskDocument` 深快照；文档大（几百条笔画点）时内存放大 100 倍。目前量级尚可，K4 像素 ops 进来后要重新评估。

## 四、短路（有意的旁路，需要知道它们存在）

| 短路 | 说明 | 何时会咬人 |
|---|---|---|
| 像素合成不走 grade kernel | K2 只编译调整栈；像素层合成仍由 mask 执行器重放（K4 未做） | 像素层+高级混合的预览与最终结果解释权分裂 |
| 像素层 invert 特判 | `imageCompile` 把像素层 invert 折成 LUT 翻转 grade 层（奇偶抵消） | 是唯一"像素 op 走 grade 预览"的例外，第二个类似 op 出现时应泛化而非再加特判 |
| 浏览器预览 mock 后端 | 无 Tauri 时 SAM 2 / probe / 栅格化全 mock，编辑链只到"记录意图"为止 | 浏览器里"验证通过"不代表桌面端行为 |
| underlay 的 CSS 变换 | move/free-transform 只在展示层做 CSS，源帧不动 | 与后续 op（如按像素采样的 wand）叠加时预览失真 |
| `baseHidden` 走 prop 链而非文档 | 底图隐藏是 MaskStage 的展示 prop，不是文档可见性直接驱动渲染 | 上次隐藏按钮 bug 的根源模式：文档状态与渲染链之间多一跳人工接线 |
| agent 动作不直接改文档 | studioAction commit 只产出普通撤销步；canvas/model-api 动作只产出 host command | 这是设计的护栏，不是缺陷——但意味着 host 侧 dispatch 是每类 command 的单点 |

## 五、建议的下一步（按性价比排序）

1. ~~**拆 MaskEditModal 的指针状态机**~~ ✅ 已完成（#590 整体搬入 pointerMachine.ts，#591 按工具类型拆成 pointer/ 12 个子模块）。
2. ~~**给桥加护栏**~~ ✅ 已完成（#589：`maskBridgeGap` 诊断 + 提交/恢复告警，可桥接混合列表与 `LAYER_BLENDS` 收敛单一来源）。
3. ~~**默认坐标系显式化**~~ ✅ 已完成（#589：无底图时"预览坐标系 960×640"角标）。
4. ~~**normalizeEditPaths 丢弃时上报**~~ ✅ 已完成（#589：丢弃图层 console.warn 上报）。

---

## 六、重构进展与下一步（更新于对话框/颜色/导航/场景/路径拆分后）

### 已落地
| PR | 内容 | 行数变化 |
|---|---|---|
| #589 | 桥护栏 / 坐标系角标 / normalize 丢弃上报（建议②③④） | — |
| #590 | 指针状态机整体搬入 `pointerMachine.ts`，壳只留三个薄 handler | 2552 → 1996 |
| #591 | `pointerMachine` 按工具类型拆成 `pointer/` 12 个子模块（97 行分发壳） | — |
| #592 | 裁剪工具状态簇 → `useCropTool` hook；浮动裁剪面板 / 选区尺寸面板 → `CropPanel` / `MarqueeSizePanel` 组件 | 1996 → 1772 |
| #594 | 对话框草稿簇（Ctrl+T / Shift+F5 / Ctrl+Alt+I）→ `useDialogDrafts` hook + `ImageSizeDialog` 组件 | 1772 → 1551 |
| 本次 | 颜色/取样簇 → `useColorTools`；视图/画布簇 → `useCanvasNavigation`；redraw 场景组装 → `stageScene`（`buildViewportOverlayScene` + `paintStage` 纯函数）；路径编辑簇 → `usePathEditing` | 1551 → 1290 |

### 下一步候选（MaskEditModal 继续瘦身，按内聚度排序）
1. **笔刷参数簇**：`brushSize`/`brushHardness`/`brushFlow`/`brushSpacing` 与括号键快捷调整，可拆成 `useBrushParams`。
2. **工具槽位簇**：`selectTool`/`selectSlot`/`cycleSlot`/`slotFaces`（PS 槽位字母与 Shift 轮换），可拆成 `useToolSlots`。
3. **JSX 面板继续组件化**：右侧 dock 的面板装配（`buildPanels`）仍在壳内，可按面板逐个下沉。

每步保持纯重构契约：不改行为、不改公共 API，靠现有测试（1110 个）+ typecheck 验证。
