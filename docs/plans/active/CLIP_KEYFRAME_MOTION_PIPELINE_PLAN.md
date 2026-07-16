# Clip Keyframe & Motion Pipeline Plan（关键帧与运动渲染管线路线图）

目标：为时间线 clip 属性（变换 / 裁剪 / 不透明度，后续扩展）建立**性能优先、无历史包袱**的关键帧动画管线——从面板打点，到预览合成，到导出编码，全程一套求值语义、一条 GPU 合成路径。

现行关联文档：

- [`GPU_DEVICE_STRATEGY_PLAN.md`](GPU_DEVICE_STRATEGY_PLAN.md)（设备报告与 Windows GPU 边界）

> Status: implementation landed, not archived yet. Phases 1-5 landed across
> #612, #616, #617, and #618: Rust/TS keyframe evaluation, export property
> compositing, shared preview/export pixel path, linear/hold/bezier
> interpolation, timeline keyframe lane, hit targets, and property-compositor
> performance/device reporting are present in code. Keep this document active
> only until native end-to-end preview/export evidence is captured with the
> repository-maintained FFmpeg binaries restored from Git LFS. Do not use
> external FFmpeg libraries to satisfy that evidence gap.

---

## 1. 对标分析：Premiere / Resolve 哪些是本质设计，哪些是历史包袱

### 1.1 必须继承的本质设计

| 设计 | 为什么是本质的 | 我们的对应物 |
| --- | --- | --- |
| 每属性一条 keyframe track，按 clip 本地时间求值 | 动画的最小正交模型；任何 NLE 都绕不开 | `ClipProperties.tracks`（`"transform.scalePct"` 等 path → `{t, v}[]`），已落地（#612） |
| 求值权威只有一个 | 预览和导出各写一套插值 = 永远对不齐 | Rust `clip_props.rs` 是真值；TS 镜像同一语义，共享 fixtures 强制到 1e-9 |
| 静态值是"零关键帧"的退化情形 | 属性面板不需要"动画模式开关"这种状态机 | 无 track 的属性直接取文档静态值 |
| 逐帧 resolve → 合成 → 编码，一条流水线 | 导出画面必须等于预览画面 | `timeline_export` 已有 decode → grade → encode 帧流水线，属性应用插入同一条线 |
| GPU 合成 | 变换/裁剪/不透明度是纯像素仿射操作，GPU 是唯一合理归宿 | 现有 wgpu viewport host + `hgripe-grade` GPU kernel 的同一套设备栈 |

### 1.2 明确抛弃的历史包袱

| 包袱 | PR / Resolve 为什么背着 | 我们为什么不背 |
| --- | --- | --- |
| CPU 合成主路径 + 插件 ABI（AE/OFX 插件生态） | 三十年插件生态必须兼容 | 无插件生态要兼容；效果即 Rust/wgpu kernel，进程内直调 |
| 多种历史插值模式并存（旧工程的 hold/linear/bezier 变体都要按当年语义重放） | 旧工程文件必须逐比特还原 | 工程格式是我们自己的 JSON schema；插值语义只有一份，升级 schema 时迁移文档而不是永久兼容旧语义 |
| 隔行扫描 / drop-frame timecode / 磁带遗留的时基换算 | 广播工作流遗产 | 只支持逐行、恒定 fps 的现代交付；时间统一为 f64 秒 |
| Sequence conform（素材属性和序列设置不一致时的自动适配层层叠叠） | 用户几十年的工程习惯 | 素材进入时间线即按我们的轨道规则路由（图轨/视频轨严格分离已落地），无 conform 层 |
| 关键帧存放在效果实例里（每个效果一套动画容器） | 效果插件各自为政的历史 | 关键帧统一挂在 clip 属性文档上，一个容器、一种序列化 |
| 每帧重新解析工程数据 | 对象模型太重，没法增量 | 文档 parse 一次/每 clip；逐帧只做 O(1) 游标推进求值（见 §3） |

结论：我们要的是 PR 的**分层求值模型**，不是它的实现史。性能路线 = Rust 单一求值 + wgpu 单一合成 + 逐帧零解析。

---

## 2. 现状（Phases 1-5，代码已落地，待 native 证据补齐）

- 文档模型：`ClipProperties`（transform / crop）+ 可选 `tracks`；clamp 规则统一（scale 0..10000%，opacity/crop 0..100%，对边 crop 之和 ≤ 100%）。
- Rust 权威求值器：`src-tauri/src/studio/clip_props.rs` — `parse_clip_props_doc` / `resolve_clip_props_at(doc, t)`；键按时间排序、端点保持、`linear` / `hold` / `bezier` 插值、非法键过滤。
- TS 镜像：`studio-ui/src/production/keyframes.ts` — 同一语义 + 面板辅助（`toggleKeyframe` / `setClipPropValueAt` / `resetClipPropsSection` / `setKeyframeInterpolationAt`）。
- 对齐契约：`clipPropsKeyframeFixtures.json`，Rust 测试与 vitest 同时逐样本断言到 1e-9，两边永不静默漂移。
- 面板：每个标量旁菱形按钮（播放头处打/删键），右键菜单选择插值类型；数值显示为播放头处求值结果；动画属性上改值 = upsert 关键帧。
- 像素路径：`timeline_export` 接收 `prop_docs` / `prop_times`，逐帧 resolve 后调用 `apply_clip_props_preferred`；`ProgramMonitor` 预览复用 `apply_clip_props_srgb_proxy_preferred`，预览与导出共用同一 Rust 属性合成语义。
- GPU / fallback：`clip_props_gpu.rs` 是 wgpu 属性合成路径，`clip_props_raster.rs` 保留 CPU fallback 与金样本基准；导出报告 `props_frame_count` / `props_time_ms` / `props_backend` / fallback reason。
- 时间线 lane：选中 clip 时显示关键帧组菱形，可点击、拖动改时、Shift 吸附、双击删除；#618 修正了菱形独立点击命中。
- 仍待补证据：native 预览/导出录屏和导出产物验收被 Git LFS FFmpeg 配额阻断；仓库维护的 `third_party/ffmpeg/**` 恢复后补跑，再决定是否归档。

---

## 3. 性能设计原则（后续所有 Phase 的硬约束）

1. **解析一次，求值 N 帧**：属性文档每 clip 只 `parse_clip_props_doc` 一次；导出循环内不得出现每帧 JSON parse。求值使用排序后的 track + 单调递增游标，逐帧推进为 O(1)（时间只会前进）。
2. **合成在 GPU**：变换（平移/旋转/缩放/锚点）+ 裁剪 + 不透明度合成为**一个** wgpu pass 的一次仿射采样（一个 3x3 矩阵 + crop uniform + opacity uniform），不做多 pass 叠加；CPU 路径只作为无适配器 fallback，语义按共享 kernel 对齐（与 `hgripe-grade` 的 cpu/gpu 报告契约一致）。
3. **恒等零成本**：resolve 结果等于恒等（默认值）时跳过整个属性 pass——静态无动画工程的导出性能与今天完全一致。
4. **帧级缓存按量化参数为键**：导出中重复帧沿用现有 `(path, doc)` 缓存策略，扩展为 `(path, quantized resolved props)`（参数量化到 1e-4），静帧上的慢动画只渲染值变化的帧。
5. **预览=导出**：两边跑同一个 Rust apply 函数；用金帧测试（同 `export_grade_matches_preview_within_tolerance` 的模式）钉住容差。
6. **时间只有一种**：clip 本地 f64 秒。fps 只在帧号↔秒换算的边界出现（renderPlan 展开、监视器步进），求值层永不感知 fps。

---

## 4. 路线图

### Phase 2 — 导出管线应用属性（已落地，#617）
Rust：
- 新增 `apply_clip_props` 光栅算子：输入解码帧 + `ResolvedClipProps`，输出同尺寸合成帧（crop → 仿射变换（anchor/position/scale/rotation）→ opacity 混合到画布）。首版 CPU 参考实现 + 单测（恒等跳过、裁剪、缩放、不透明度各金样本），为 Phase 3 的 GPU kernel 定语义。
- `timeline_export` 增加 `prop_docs: Option<Vec<Option<String>>>`（与 frames 对齐，每 clip 一份文档字符串）+ `prop_times: Option<Vec<f64>>`（每帧 clip 本地时间）；在 decode 之后、grade 之前插入 `resolve_prop_frames`（文档 parse 每 clip 一次；§3 的缓存与恒等跳过）。
TS：
- `RenderSegment` 增加 `propsDoc: string | null`（`buildRenderPlan` 经 `clipPropsDoc` 回调取自 store）；`expandPlanFrames` 输出对齐的 `propDocs` 与 `propTimes`（帧 i 的 clip 本地时间 = min(i/fps, duration)）。
- App 导出调用透传两个新数组。
验收：带关键帧的导出逐帧可见动画；无属性文档的工程走原路径（零新增开销）；`cargo test` 金样本 + vitest 展开对齐测试。

### Phase 3 — 预览同一像素路径（已落地，#617）
- viewport host 新增 `set_clip_props` 命令（与 `set_grade` 同形：doc JSON + 帧时间），`video_preview` 呈现前跑同一个 `apply_clip_props`（wgpu kernel 落地在这一步，导出同时切换到 GPU 路径，CPU 参考实现降级为 fallback + 测试基准）。
- `ProgramMonitor.showFrame` 增加 `propsDoc` + clip 本地时间（跳过恒等文档，避免无谓命令）。
- 金帧测试：预览呈现 vs 导出帧容差断言（复用既有 grade 对齐测试模式）。
验收：拖动播放头即见动画；预览/导出像素级一致（容差内）；DeviceReport 报告属性合成的 cpu/gpu 与 fallback 原因。

### Phase 4 — 插值升级（缓动，已落地，#616）
- schema：`Keyframe` 增加可选 `interp`（`"linear"`（默认）/ `"hold"` / `"bezier"`，bezier 带两个控制点）；旧文档缺省即 linear——schema 演进靠缺省值，不留兼容分支。
- fixtures 扩展 bezier/hold 样本；Rust 与 TS 同步实现，1e-9 契约不变。
- 面板：关键帧右键菜单选择插值类型。

### Phase 5 — 时间线关键帧 lane 与性能仪表（已落地，#617 / #618）
- clip 条上渲染关键帧菱形（选中 clip 时），拖动改 `t`，双击删除；与 Shift 吸附集成（关键帧成为吸附源）。
- 性能仪表：导出报告属性合成帧数/耗时；预览路径把 decode+props+grade 各段耗时并入 DeviceReport，为 4K 帧预算（GPU 合成 < 2ms/帧）提供量测。

### 非目标（明确不做）
- 效果插件系统 / 第三方动画曲线格式导入。
- 隔行、drop-frame、可变帧率时间基。
- 每效果独立的动画容器（关键帧永远挂在 clip 属性文档上，未来音量动画同样以 `"audio.gainDb"` path 进同一容器）。

---

## 5. 测试策略（每 Phase 的硬门槛）

1. **共享 fixtures 是唯一契约**：任何插值语义改动必须先改 `clipPropsKeyframeFixtures.json`，Rust 与 TS 同 PR 通过。
2. **光栅金样本**：`apply_clip_props` 的每种操作（crop/scale/rotate/opacity/组合）在 Rust 侧有确定性的像素断言；GPU kernel 上线后 cpu/gpu 双跑对齐（容差 ≤ 1/255）。
3. **预览=导出金帧**：Phase 3 起，同一工程同一时间点的预览帧与导出帧断言容差，纳入 `cargo test`。
4. **性能回归线**：静态工程（无 tracks）导出耗时不得因本管线增加（恒等跳过的守门测试）。
