# H-Gripe Studio 架构职责与冗余审计

> 状态：审计结论与整改建议，不代表已经实施。
> 基线：`main` at `57f6b221`（2026-07-09）。
> 目标：识别职责混杂、重复实现、错误分层、超大变更热点与疑似冗余，并给出可逐步验证的拆分顺序。

## 1. 结论摘要

当前最重要的问题不是“文件太大”本身，而是同一图像文档语义分散在多套实现中：

1. 前端 proxy、Subject Mask 执行器和 viewport 各自实现图层回放、蒙版、混合或变换；
2. `subject_mask.rs` 与 `viewport.rs` 同时承担命令入口、状态、缓存、解析、算法和合成；
3. `App.tsx` 与 `MaskEditModal.tsx` 仍是高扇入、高变更冲突的总控组件；
4. 跨层合同和纯领域模型位于 `types/production.ts`、`production/layeredImage.ts` 等 feature 目录，导致 runtime、editor、viewport 反向依赖 UI feature；
5. API provider 重复实现 profile、credentials 和任务参数合并规则。

最高优先级应是先锁定图像文档的跨实现语义，再建立一个 Rust 权威内核。直接从 UI 拆小组件开始，不能解决预览、执行和导出结果漂移的问题。

## 2. 范围与排除项

### 2.1 本次审计范围

- `apps/desktop-tauri/studio-ui/src/`
  - editor
  - graph
  - runtime
  - production
  - viewport
  - bridge
  - models
- `apps/desktop-tauri/src-tauri/src/`
  - commands
  - studio
- `crates/hgripe-api/`
- `crates/hgripe-grade/`
- 与上述实现直接相关的 `docs/design/`、`docs/notes/`、`docs/plans/active/`

### 2.2 明确排除

- FFmpeg 二进制、打包、下载和 native FFmpeg 功能改造；
- `third_party/`、生成产物、构建缓存；
- 已从产品运行时移除的 ComfyUI/Python 树。除非先完成 upstream/legacy 归属确认，否则不以“文件大”为理由重构；
- 本文不直接改变产品行为，不删除兼容路径。

`CONTRIBUTING.md` 已明确当前产品后端为原生 Rust、无 Python runtime，因此顶层 ComfyUI 源码不应和一方桌面产品代码采用同一整改优先级。

## 3. 方法与优先级

本次使用以下证据，而不是只看行数：

- 文件的 import/export 密度；
- 同一文件内实际承担的责任类型；
- 同一语义是否在多个层重复实现；
- feature 目录之间的依赖方向；
- 项目架构文档规定的目标边界；
- 测试是否已经证明某段“疑似冗余”仍用于兼容或 lowering。

优先级定义：

| 级别 | 含义 |
| --- | --- |
| P0 | 已构成结果漂移或核心回归风险，应在继续扩功能前处理 |
| P1 | 高变更热点或明显层级错误，近期应拆 |
| P2 | 主要增加维护和合并成本，可在 P0/P1 后处理 |
| P3 | 声明型大文件、测试布局等低风险整理项 |

## 4. 量化基线

以下行数为物理行近似值，重点是职责密度，不作为单独拆分理由：

| 文件 | 规模/特征 | 主要问题 |
| --- | ---: | --- |
| `studio-ui/src/App.tsx` | 约 2027 行、60 个 import | 应用总控混入多个业务 controller |
| `editor/MaskEditModal.tsx` | 约 1693 行、54 个 import | 违反项目规定的 orchestrator-only 边界 |
| `editor/maskMorphology.ts` | 约 1414 行、41 个 export | proxy 算法、工具、回放、合成、缓存混合 |
| `editor/maskEdit.ts` | 约 922 行、61 个 export | 状态、迁移、命令和查询 API 过于集中 |
| `production/ProductionDrawer.tsx` | 约 1054 行 | props 面过宽，素材、时间线、检查器混合 |
| `runtime/executors.ts` | 约 745 行 | 多类 executor 注册与协议转换集中 |
| `graph/nodeSpecs.ts` | 约 1985 行 | 声明型 registry 过大，但内聚性尚可 |
| `types/production.ts` | 约 621 行、50 个 export | 多个跨语言合同域混在单文件 |
| `commands/viewport.rs` | 测试从约 3035 行开始 | 状态、registry、缓存、overlay、渲染混合 |
| `studio/subject_mask.rs` | 测试从约 3003 行开始 | 执行入口、文档迁移、工具算法、合成混合 |
| `providers/custom_http.rs` | 约 1612 行 | 传输、异步任务、profile、auth、输出混合 |
| `providers/openai_compatible.rs` | 约 1491 行 | 多种 operation、multipart、auth、输出混合 |
| `history.rs` | 约 1112 行 | JSONL、SQLite、清理、脱敏和路径混合 |

## 5. 详细发现

### A01 / P0：图像文档语义存在多套实现

#### 证据

前端 `editor/maskMorphology.ts` 的文件说明将自身定义为低分辨率 advisory preview，但实际包含：

- `replayOps`
- `adjustmentLut` / `applyAdjustment`
- `blendValue` / `blendInto`
- `renderLayerSurface`
- `buildProxyMask`
- per-layer cache 与 dirty-tile compositor

Rust `studio/subject_mask.rs` 又实现：

- edit-path 迁移与规范化；
- 图层操作回放；
- 调整层 LUT；
- 灰度图层混合；
- brush、heal、clone、crop、transform、morphology 等工具；
- mask/alpha/cutout 输出。

Rust `commands/viewport.rs:2579-2955` 再实现：

- `composite_image_document`
- `LayerTransform`
- `raster_layer_mask`
- polygon raster；
- `blend_channel`
- source-layer composite。

同时 `crates/hgripe-grade/src/blend.rs` 已经有更完整、按 W3C/Photoshop 语义实现并有 golden 约束的 `BlendMode`、`blend_channel` 和 `blend_rgb`。

#### 风险

- 编辑器 proxy、执行结果和 viewport 可能对同一文档给出不同结果；
- 新增 blend、transform、mask op 时必须同步修改三处以上；
- 局部实现只覆盖有限 blend mode，容易静默回退为 normal；
- 修复一条渲染路径后，另一条路径仍保留旧 bug。

#### 目标边界

建立 Rust 权威模块：

```text
studio/image_document/
  model.rs
  normalize.rs
  op_replay.rs
  mask_raster.rs
  transform.rs
  compositor.rs
  fixtures.rs
```

- `subject_mask` 负责节点输入、模型分割、调用文档内核和发布输出；
- viewport 负责选择 target、准备 frame、调用同一 compositor；
- `hgripe-grade` 保持颜色与 blend 数学的唯一实现；
- TS proxy 允许近似，但只能消费同一文档合同，并由共享 fixture 约束不变量。

#### 验收

- single-layer 文档执行结果与当前结果字节一致；
- 所有支持的 blend mode 由同一 Rust enum 解析；
- transform + linked/unlinked mask 在 subject mask 和 viewport 中一致；
- adjustment layer 对共享 fixture 输出一致；
- TS proxy 不写回权威像素结果。

---

### A02 / P0：`subject_mask.rs` 是算法与编排混合的单体

#### 证据

`apps/desktop-tauri/src-tauri/src/studio/subject_mask.rs` 在测试模块之前约 3000 行，包含：

- `execute_studio_subject_mask` 执行编排；
- 输入参数与图片/蒙版加载；
- edit document 解析、v1/v2/v3 迁移和规范化；
- 图层、layer mask、adjustment、blend；
- 多种工具算法；
- morphology、coverage、bbox；
- alpha/cutout 合成；
- PNG 写出与 report。

#### 问题

这些责任的变化频率不同：

- 合同迁移需要极度稳定；
- 工具算法会持续增加；
- 输出/report 跟节点协议一起变化；
- compositor 应被 viewport 等其他消费者复用。

全部集中在一个模块会迫使无关修改共享同一编译和 review 边界。

#### 建议拆分

```text
studio/subject_mask/
  mod.rs              # executor entry only
  inputs.rs           # node/input parsing
  document.rs         # edit document normalize/migrate
  replay.rs           # tool op dispatch
  raster_ops.rs       # brush/path/morphology algorithms
  outputs.rs          # mask/alpha/cutout/report
```

通用 document/compositor 逻辑不留在 `subject_mask/`，而进入 A01 的共享内核。

#### 迁移规则

第一批 PR 只移动函数和测试，不修改算法；共享内核替换放在后续 PR。禁止一次提交同时做“拆文件 + 改输出”。

---

### A03 / P0：`viewport.rs` 同时是状态服务、资源 registry 和渲染器

#### 证据

`apps/desktop-tauri/src-tauri/src/commands/viewport.rs` 在测试模块之前约 3034 行，包含：

- viewport 生命周期和全局状态；
- source proxy 与 LRU cache；
- layered asset、timeline、node output 三类 registry；
- mask overlay 与 overlay scene 绘制；
- temporal chain；
- Tauri command 参数校验；
- frame 编码、binary payload；
- image/video path 渲染；
- clip props；
- image document compositor。

#### 风险

- command 层和 renderer 层相互牵制；
- registry 锁、cache 和渲染算法难以独立测试；
- image-document 逻辑和 `subject_mask.rs` 重复；
- 新 target 类型会继续扩大单文件和全局状态面。

#### 建议拆分

```text
commands/viewport.rs          # thin command facade
studio/viewport/
  service.rs                  # lifecycle + orchestration
  state.rs
  registries.rs
  proxy_cache.rs
  overlays.rs
  render_image.rs
  render_video.rs
  frame_io.rs
```

image document composite 调用 A01 共享内核，不在 viewport 子模块中再保留一份。

---

### A04 / P1：`App.tsx` 是应用级 god component

#### 证据

`apps/desktop-tauri/studio-ui/src/App.tsx` 约 2027 行、60 个 import。`Studio` 组件同时处理：

- graph nodes/edges、选择和拖动；
- canvas tabs、项目 manifest 和 autosave 恢复；
- run controller 与多画布运行；
- media bin、timeline、marker、track、clip；
- layer merge/split/protected/visibility；
- image/audio/grade editor 打开与提交；
- dropped files；
- assistant 插入与创建；
- 顶层 modal、drawer、toolbar 和 canvas 渲染。

#### 问题

`App.tsx` 已不是单纯 composition root。每个业务域都向同一个组件追加 state、callback 和 effect，导致：

- 修改一个 feature 时需要理解整个应用状态面；
- callback 链和 effect 顺序成为隐式状态机；
- `ProductionDrawer` 等子组件通过超宽 props 获取整个业务 API；
- controller 已部分抽出，但 ownership 仍不清晰。

#### 建议拆分

```text
app/
  StudioShell.tsx
  useCanvasWorkspaceController.ts
  useProductionWorkspaceController.ts
  useEditorLaunchController.ts
  useProjectRestoreController.ts
```

`App.tsx` 最终只负责：

1. 初始化顶层 store/controller；
2. 组合 `StudioShell`；
3. 提供少量 context/provider；
4. 不直接实现生产区或编辑器业务 mutation。

避免创建一个同样庞大的 `useStudioController`；controller 应按 ownership 拆分，而不是把原文件整体搬入 hook。

---

### A05 / P1：`MaskEditModal.tsx` 未达到项目自己的 orchestrator-only 目标

#### 证据

`docs/design/mask-editor-ui-structure.md` 明确规定：

- `MaskEditModal.tsx` 为 “orchestrator ONLY”；
- “must not grow logic”；
- painter、pointer branch、panel 应进入对应模块。

当前 `MaskEditModal.tsx` 仍约 1693 行、54 个 import，仍负责大量：

- 工具选择和 slot 轮换；
- brush 参数和快捷调整；
- active selection 推导；
- dock persistence；
- underlay/preview 协调；
- scene 数据组装；
- command/shortcut glue；
- 多个 dialog 和 panel 的状态。

`docs/notes/image-editor-review.md` 已列出后续候选：

- `useBrushParams`
- `useToolSlots`

#### 建议拆分

优先按状态簇拆 hook，而不是继续拆纯 UI：

```text
maskEditModal/
  useBrushParams.ts
  useToolSlots.ts
  useMaskPreviewController.ts
  useUnderlayController.ts
  useMaskEditorShortcuts.ts
```

`LayersPanel.tsx` 约 793 行，可拆：

```text
layers/
  LayersPanel.tsx
  LayerRow.tsx
  LayerThumbnail.tsx
  LayerGroupEditor.tsx
  LayerActions.tsx
```

所有文档 mutation 继续通过 `actions.ts` + `maskEdit.ts`，不得在 panel 内直接修改 `MaskDocument`。

---

### A06 / P1：`types/production.ts` 是多个合同域的聚合桶

状态（2026-07-10）：已完成。合同已按 artifacts、context、quality、mask operations、mask document 与 subject mask 拆分到 `contracts/`；内部调用方已迁移到对应的聚焦模块，`types/production.ts` 仅保留兼容 re-export。

#### 证据

`apps/desktop-tauri/studio-ui/src/types/production.ts` 约 621 行、50 个 export，并声明自身需与 Rust `contracts.rs` 手工保持一致。文件同时包含：

- visual/background/lighting context；
- quality/repaint report；
- edit paths、brush、mask operations；
- layer group、adjustment、mask layer、layer mask；
- image canvas；
- mask document；
- detected subject、matte report、subject mask result。

#### 风险

- 任意合同变更都触碰同一文件；
- UI、bridge、editor 依赖远超所需的合同域；
- TS/Rust 字段靠人工 lock-step，漂移只能在运行期发现；
- `production` 命名掩盖了其中大量 editor/domain 合同。

#### 建议拆分

```text
contracts/
  context.ts
  quality.ts
  maskOps.ts
  maskDocument.ts
  subjectMask.ts
  index.ts
```

先保留 `types/production.ts` 作为兼容 re-export，再逐步迁移 import。增加 Rust serialization fixture 与 TS parse fixture，验证 snake_case、可选字段和 version migration。

---

### A07 / P1：纯领域模型放在 feature UI 目录，产生反向依赖

状态（2026-07-10）：已完成。layered image 模型与测试已迁移到 `domain/`，runtime、editor、production 与 app 调用方均直接依赖共享领域模块；原路径仅保留兼容 re-export。

#### 证据

`production/layeredImage.ts` 被以下非 production UI 模块直接使用：

- `runtime/executors.ts`
- `editor/HgripeNode.tsx`
- `editor/useStudioRunController.ts`
- viewport hooks/tests

这说明 layered image asset 是共享领域模型，不是 production drawer 私有实现。

#### 建议

移动到：

```text
domain/layeredImage.ts
```

依赖方向固定为：

```text
domain <- runtime
domain <- editor
domain <- production
domain <- viewport
```

禁止 runtime 依赖 `production/`、editor 依赖 `production/` 中的纯模型。类似规则也适用于 preview target、media asset 等跨 feature 类型。

---

### A08 / P1：API provider 重复 profile、credentials 和参数合并

状态（2026-07-10）：已完成。`custom_http`、`openai_compatible` 与后续加入的 `replicate` 已共享 `providers/common/` 下的 task 参数读取、profile merge policy、credentials/API key 优先级及输出文件类型辅助逻辑；provider 差异通过显式 policy 保留。

#### 证据

`custom_http.rs:703-915` 与 `openai_compatible.rs:716-1079` 存在相同或高度相似的：

- `value` / `value_str` / `value_bool`
- `credentials_file`
- `profiles_file`
- `profile_ref`
- `apply_provider_profile`
- `merge_provider_profile`
- `insert_optional_string`
- `insert_effective_param`
- `merge_task_param`
- `value_is_blank_string`
- credentials lookup 与 provider 校验

两者的差异主要是允许合并的结构字段和 provider 特有字段。

#### 风险

- profile override 优先级可能在 provider 间漂移；
- blank string、header/query/extra body merge 的边界不同；
- credentials 错误消息和 provider 校验重复维护。

#### 建议拆分

```text
providers/common/
  task_params.rs
  profile_merge.rs
  credentials.rs
  output_files.rs
```

用显式 policy 参数描述 provider 差异，例如：

```rust
ProfileMergePolicy {
    scalar_keys,
    object_merge_keys,
    provider_name,
}
```

不要用泛型“大一统 provider”；只提取明确重复的协议前处理和基础设施。

---

### A09 / P2：`ProductionDrawer.tsx` 的 props 面相当于完整业务服务

#### 证据

`ProductionDrawerProps` 包含素材导入/删除、clip/track/marker、编辑器打开、grade、layer split/merge、visibility、protected、frame export 等大量回调。

#### 建议

- drawer container 直接订阅 production store selector；
- 将外部应用能力压缩为少量 ports，例如 `editorLauncher`、`layerService`、`exportService`；
- 拆 `AssetBinView`、`TimelineView`、`DrawerToolbar`、`ClipInspector`；
- 避免把 store 的每个 action 再包装成一条 prop。

状态（2026-07-10）：已完成。drawer container 已直接订阅 production store，并将编辑器、图层、导出和素材箱能力聚合为显式 ports；toolbar 与 inspector 已拆为独立组件，`App.tsx` 不再逐项传递 timeline/clip/store actions。

---

### A10 / P2：node spec 与 executor registry 需要更强的一致性边界

状态（2026-07-10）：已完成。node specs 已按 source、generation、image、PSD、quality、video、workflow、output 与 internal 领域拆分，browser-preview executors 已按 graph、API、image 与 video 执行域拆分；聚合层拒绝重复注册，并新增跨 registry 一致性测试。

#### 证据

- `graph/nodeSpecs.ts` 集中声明约二十余类节点；
- `runtime/executors.ts` 集中注册对应执行行为；
- editor、runtime、models 多处直接查询 `NODE_SPECS` 或 `nodeSpec`。

大文件本身主要是声明数据，问题是 spec 与 executor 是两个人工维护的 registry。

#### 建议

- node specs 按 source/generation/image/video/export/internal 分类；
- 对外仍合并为单一 `NODE_SPECS`；
- executors 按 lane/provider family 拆模块；
- 增加全量断言：
  - 所有非容器、非 internal、可执行 spec 都有 executor；
  - executor 声明的 kind 必须存在于 spec；
  - spec 的 executor lane 与实际 registry 一致；
  - internal primitive 仍可被旧工作流/lowering 解析。

---

### A11 / P2：`bridge/viewport.ts` 混合合同、客户端和浏览器 mock

#### 证据

该文件约 794 行、40 个 export，既定义 viewport target/frame/backend 类型，也封装 Tauri 调用并维护 browser/test mock。

#### 建议

```text
bridge/viewport/
  contracts.ts
  client.ts
  mock.ts
  index.ts
```

生产调用方只依赖 `client` 接口；测试通过注入 mock client，而不是从生产 bridge 暴露 mock 计数器。

---

### A12 / P2：`history.rs` 与 `profiles.rs` 各自混合存储、规则和安全处理

#### `history.rs`

当前同时包含：

- record 构建；
- JSONL append/rewrite；
- SQLite schema/upsert/query；
- cleanup plan/apply；
- output file 删除；
- runtime path/env；
- task snapshot 脱敏和摘要。

建议拆为：

```text
history/
  model.rs
  repository.rs
  jsonl.rs
  sqlite.rs
  cleanup.rs
  sanitizer.rs
  runtime_paths.rs
```

#### `profiles.rs`

当前同时包含 load、resolve、validate、redact 和 env 检查。建议拆为：

```text
profiles/
  model.rs
  load.rs
  resolve.rs
  validate.rs
  redact.rs
```

安全相关的敏感字段识别应复用统一 helper，避免 history/profile/credentials 各自维护不同 key 集合。

---

### A13 / P3：声明型大文件只需按域拆分，不应过度抽象

#### `i18n.ts`

虽然约 1328 行，但主要是稳定 key 到英中字符串的声明表。建议按 editor/production/models/runtime/common 拆 dictionary，再在入口合并；不需要引入复杂 i18n framework。

#### `nodeSpecs.ts`

虽然约 1985 行，但 catalog 本身内聚。按类别拆文件主要用于降低冲突和 review 负担，不应把每个 node 拆成一个文件，也不应改变保存格式。

## 6. 不应误判为冗余的代码

### 6.1 feature-gated `allow(dead_code)`

`studio/wgpu_device.rs` 中多处 `allow(dead_code)` 标注了 surface presentation 的 feature 条件或阶段性接线。没有确认 feature matrix 和调用路径前，不应删除。

### 6.2 legacy autosave

`App.tsx` 的 legacy single-graph autosave 是 manifest 迁移 fallback。应先定义兼容窗口、迁移统计和删除版本，再考虑移除。

### 6.3 internal primitive nodes

`nodeSpecs.test.ts` 明确要求 Number/Compare/Switch 等 internal primitive 继续存在，以支持旧工作流和 lowering。它们从 palette 隐藏不等于死代码。

### 6.4 前端 proxy 与 Rust 权威结果

前端 proxy 不是简单重复代码：交互需要低延迟 advisory preview。应删除的是重复的“权威语义”，不是 preview lane 本身。

### 6.5 Rust 内联测试

大测试模块会增加文件长度，但通常不构成运行时职责混杂。可在生产模块稳定拆分后，将测试按子模块迁移；不要为了行数先移动测试。

## 7. 分阶段整改计划

### Phase 0：锁定行为与合同

目标：任何后续拆分都可证明没有改变输出。

新增共享 fixtures：

1. single-layer document；
2. 多层 opacity + blend；
3. linked/unlinked layer mask；
4. translate/scale/rotate 组合；
5. adjustment layer；
6. v1/v2/v3 edit document migration；
7. brush/path/morphology replay；
8. empty-layer document；
9. canvas resize/resample；
10. subject mask、viewport 和 TS proxy 的共同不变量。

TS proxy 不要求逐像素等于 Rust，但应验证：

- bounds；
- coverage 容差；
- layer visibility/order；
- mask target；
- blend/adjustment 方向；
- migration 后的 op 顺序。

预计：1–2 天。风险：低。

### Phase 1：建立 Rust image-document 权威内核

1. 让 viewport 的 blend 使用 `hgripe-grade`；
2. 抽取 transform、mask raster 和 compositor；
3. subject mask 与 viewport 切换到共享实现；
4. 保留兼容 adapter，逐步删除旧私有实现。

预计：4–7 天。风险：高，但收益最高。

### Phase 2：拆 Rust 单体，不改行为

1. 拆 `subject_mask.rs`；
2. 拆 `viewport.rs`；
3. 按新模块移动对应测试；
4. 每个 PR 保持 fixture 和现有测试通过。

预计：3–5 天。风险：中。

### Phase 3：拆前端应用和编辑器 controller

1. `App.tsx` 先抽 production workspace；
2. 再抽 editor launch 与 canvas workspace；
3. `MaskEditModal` 抽 brush/tool slots、preview、underlay 和 shortcuts；
4. `ProductionDrawer` 改为 store selector + capability ports。

预计：4–7 天。风险：中。

### Phase 4：整理合同、领域边界与 registry

1. 拆 `types/production.ts`，保留兼容 re-export；
2. 移动 `production/layeredImage.ts` 到 domain；
3. 拆 viewport bridge；
4. 拆 node spec/executor registry 并添加完整性测试。

预计：3–5 天。风险：低至中。

### Phase 5：整理 broker 基础设施

1. 提取 provider common；
2. 拆 history repository/sanitizer；
3. 拆 profiles load/resolve/validate/redact；
4. 统一 sensitive-key policy。

预计：3–5 天。风险：中。

## 8. 推荐 PR 切片

| PR | 内容 | 行为变化 |
| --- | --- | --- |
| 1 | 跨路径 image-document fixtures | 无 |
| 2 | viewport blend 改用 `hgripe-grade` | 理论无；由 golden 证明 |
| 3 | 抽取 transform/mask raster/compositor | 无 |
| 4 | subject mask 使用共享内核 | 无 |
| 5 | viewport 使用共享内核 | 无 |
| 6 | 仅拆 `subject_mask.rs` 文件职责 | 无 |
| 7 | 仅拆 `viewport.rs` 文件职责 | 无 |
| 8 | 抽 `MaskEditModal` 状态簇 | 无 |
| 9 | 抽 `App.tsx` production/editor controller | 无 |
| 10 | contracts/domain/bridge 边界整理 | 无 |
| 11 | provider common | 无 |

如果某个 PR 同时出现大量文件移动和算法输出变化，应继续拆小。

## 9. 回归验证矩阵

| 区域 | 必跑验证 |
| --- | --- |
| TS 纯模型/proxy | `npm --prefix apps/desktop-tauri/studio-ui test` |
| TS 结构调整 | test + `run typecheck` + `run build` |
| Subject Mask | 目标模块测试 + desktop Rust tests |
| Viewport | lifecycle、overlay、cache、layer target、frame payload tests |
| `hgripe-grade` | blend golden、CPU/GPU parity（可用环境内） |
| Broker provider | provider profile、credentials、multipart、async job tests |
| History/profiles | JSONL/SQLite parity、cleanup dry-run、redaction tests |

图像内核重构还应保留至少一组真实 PNG fixture，比较：

- dimensions；
- alpha；
- selected bounds；
- per-channel tolerance；
- report metadata；
- output artifact completeness。

## 10. 架构守则

后续修改应遵守：

1. document model 是唯一事实源，panel 和 viewport 不私自维护第二份文档语义；
2. frontend proxy 是 advisory，不提交权威像素；
3. command 文件只做边界校验和服务调用；
4. runtime 不依赖 feature UI 目录；
5. 一次 PR 只做纯搬迁或行为修改中的一种；
6. 不修改测试来掩盖重构回归；
7. 不删除 legacy/internal/feature-gated 路径，除非有调用证据和迁移计划；
8. 不因文件大而拆：先识别独立责任、复用消费者和变化原因。

## 11. 建议立即开始的工作

第一轮只做：

1. Phase 0 共享 fixture；
2. Phase 1 Rust image-document 内核；
3. Phase 2 的两个 Rust 单体拆分。

这一组直接降低编辑器预览、Subject Mask、viewport 和最终输出不一致的概率。`App.tsx` 与 `MaskEditModal.tsx` 的 UI 瘦身应紧随其后，但不应抢在渲染语义统一之前。
