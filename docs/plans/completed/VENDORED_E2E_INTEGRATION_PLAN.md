# Vendored Runtime End-to-End Integration Plan

> **状态更新（Phase 7，#314）：** Python runtime、`third_party/psd_tools`、PyAV
> fallback 与所有 Python torch/onnx 引擎已从仓库彻底删除。本文档中“去除
> Python 桥 / 移除 PyAV / 删除 psd_tools”类目标均已完成：native FFmpeg 是唯一
> 视频路径，Rust PSD 子集（analyze / compose / export）是唯一 PSD 路径。
> P3（hgripe-grade 接入）也已落地：图片 / 视频帧 / 时间线导出共用同一内核，
> temporal denoise 已接入视频预览，.cube LUT 可导入导出。ONNX 小模型链已完成
> 主体识别、ViTMatte 和 Refine Mask Edge 的首个复用闭环；Windows x64 CPU 运行时
> 也已转为仓库锁定、动态加载，后续主要是检测、轻量 harmonize 与 Windows GPU provider。

## 目的

H-Gripe Studio 已经开始把关键库 fork / vendor 到仓库内，并切断上游自动漂移。
这能保证可控，但不自动带来性能收益。

真正有价值的做法是：只把和生产链强相关的库端到端集成，让它们成为运行时核心；
其余库只作为可复现构建快照，不把维护成本扩大。

这个文档用于约束后续方向，避免云端和本地同时开发时把 fork 的库用错位置。

## 总原则

- fork 不是目标，稳定生产链才是目标。
- 只有进入真实运行链路的库，才值得深度维护。
- 普通依赖快照不手改，除非它变成 H-Gripe 的核心能力。
- 端到端集成必须减少中间文件、减少重复解码、减少 8-bit 往返、减少 Python 桥。
- API-first 不代表本地无价值。本地 Rust 应该负责像素、色彩、视频、PSD、小模型辅助和导出。

## 库的分层

| 库 / 目录 | 当前角色 | 是否值得端到端集成 | 长期策略 |
| --- | --- | --- | --- |
| `third_party/moxcms` | 色彩管理 fork | 是，最高优先级 | 成为全软件色彩管线核心 |
| `third_party/ffmpeg` | 本地 FFmpeg/libav | 是，最高优先级 | 成为视频和媒体引擎核心 |
| ~~`third_party/psd_tools`~~ | Python PSD 过渡库（已删除，Phase 7） | — | 已迁到 Rust PSD 子集（`psd/analyze.rs` / `psd/compose.rs` / `psd/write.rs`） |
| `third_party/cargo-vendor` | Cargo 依赖快照 | 不适合业务集成 | 只做离线构建和版本锁定 |
| `crates/hgripe-api` | API 调用 crate | 是，但属于业务协议层 | 保持干净，和本地像素内核分离 |
| `crates/hgripe-grade` | 调色 / 合成内核 | ✅ 已集成 | 统一图片和视频调色 |
| ONNX / `ort` 模型路径 | 本地小模型辅助；Windows x64 CPU 运行时已锁定 | 是，选择性集成 | 抠像、matting、检测、轻量 harmonize；分阶段接入 Windows GPU provider |

## 1. moxcms: 必须端到端集成

`moxcms` 不应该只是一个 CMYK 转 sRGB 的工具。它应该成为 H-Gripe 的色彩地基。

目标链路：

```text
source image / PSD / video frame
  -> decode
  -> 16-bit WorkingImage
  -> ProPhoto or sRGB tagged surface
  -> manual edit / mask / crop / grade / compose
  -> model egress only when needed: sRGB 8-bit
  -> export: PSD / PNG / TIFF / video with correct colour policy
```

应该端到端覆盖：

- 图片导入时的 ICC / CMYK / YCCK / TIFF 处理。
- 16-bit ProPhoto working surface。
- 手工编辑路径，不要过早压成 8-bit sRGB。
- PSD 导出前的图层 / 蒙版 / 合成色彩一致性。
- 视频调色帧的颜色空间入口和出口。
- API 输入前的模型 egress，也就是最后一步才转 sRGB 8-bit。

不应该做：

- 各个节点自己直接调用 `moxcms`。
- 每个卡片各写一套 ICC 规则。
- 中间节点反复写 8-bit PNG 再重新读取。

约束：

- `moxcms` 调用应该尽量集中在 `studio/color` 或未来独立 colour crate。
- 调色内核不直接处理 ICC。调色内核吃已经解码好的工作空间 surface。
- 所有色彩策略必须有 golden test，不能靠肉眼判断。

## 2. FFmpeg: 必须端到端集成

`third_party/ffmpeg` 如果只是用来截一张封面图，会浪费它的维护成本。

目标链路：

```text
video file
  -> native probe
  -> native decode frame
  -> frame cache / timeline preview
  -> GradeSurface / WorkingImage
  -> trim / overlay / mask / subtitle / grade
  -> native encode
  -> final video
```

应该端到端覆盖：

- 视频 probe。
- 时间线 scrub 和帧缓存。
- HEIC / AVIF 等 still container 解码。
- trim / assemble / encode。
- 视频调色帧输入。
- 画布生成结果拖到时间线后的素材处理。
- 最终导出。

已完成（Phase 7 后）：

- ✅ desktop 默认启用 native FFmpeg（唯一路径）。
- ✅ PyAV / Python fallback 已删除。
- ✅ trim / assemble / encode 均为 native（`video_trim.rs` / `video_assemble.rs`）。

长期目标（仍待做）：

- 对视频帧建立内存级 frame buffer / cache 的持续优化。
- 调色和剪辑直接消费 Rust 解码帧，而不是临时文件。

## 3. psd_tools: 已删除（Phase 7 完成）

`third_party/psd_tools` 已在 Phase 7（#314）从仓库删除：它的过渡使命已完成，
Rust PSD 子集接替了全部生产路径。下面的“长期替代”链路即现状：

```text
PSD template
  -> Rust PSD inspect / analyze
  -> layer bounds / masks / placeholders
  -> Rust pixel compose
  -> Rust PSD / PSB export
  -> Photoshop cleanup compatible output
```

Rust PSD 不需要完整覆盖 Photoshop 全格式。已覆盖 H-Gripe 生产需要的子集：

- 文档尺寸和色彩标记。
- 图层列表和分组。
- 图层 bounds。
- 图层名和 placeholder 识别。
- 蒙版读取和写入。
- 基础 opacity / normal blend。
- 智能对象或等价 placeholder 替换。
- 分层 PSD/PSB 导出。
- preview 和 metadata sidecar。

## 4. cargo-vendor: 不做业务端到端

`third_party/cargo-vendor` 是构建策略，不是运行时产品能力。

它的价值：

- 离线构建。
- 锁定 crates.io 依赖。
- 防止云端更新时依赖版本漂移。
- 保证本地和 CI 使用同一份源码。

它不应该：

- 被手工修改。
- 被当成业务库开发区。
- 为了一个小修补直接改 vendor 快照。

如果某个 crate 真的需要 H-Gripe 自己维护：

1. 从 `third_party/cargo-vendor/<crate-version>` 独立搬到 `third_party/<crate>`。
2. 添加 `VENDOR.md`。
3. 用 workspace `[patch.crates-io]` 指向这个目录。
4. 增加 golden / regression test。
5. 文档说明为什么这个库进入 H-Gripe 的核心生产链。

`moxcms` 是这个模式的正确例子。

## 5. hgripe-grade: 图片和视频的统一调色内核 — ✅ 已落地

`crates/hgripe-grade` 已端到端集成，连接图片、PSD、视频、手工编辑和导出。

目标：

- 图片调色和视频调色用同一套数学。
- PS 风格调整和 DaVinci 风格调色不要分裂成两套实现。
- 所有调整以 op graph 保存，支持撤销、复现、批处理和关键帧。
- f32 内核避免多层调色后的 banding。

它应该消费：

- `WorkingImage` 转出的 f32 surface。
- FFmpeg 解码出的视频帧。
- PSD 图层或合成结果。

它不应该负责：

- ICC profile 解析。
- 文件格式读写。
- API 调用。
- UI 状态。

分工：

```text
studio/color
  -> 负责 ICC / ProPhoto / sRGB / egress

hgripe-grade
  -> 负责 f32 blend / curves / levels / LUT / wheels

ffmpeg_native
  -> 负责视频帧 decode / encode

psd engine
  -> 负责 PSD layer / mask / export
```

## 6. ONNX / ort: 只端到端集成小模型辅助

本地小模型有价值，但不应该重新走 Python Torch/Diffusers 那条重路。

适合端到端集成：

- 主体识别。
- SAM-style 点选 refinement。
- ViTMatte matting。
- 抠像边缘辅助。
- 缺陷检测。
- 人脸 / 手部局部问题检测。
- 轻量色彩 harmonize。

不适合放进核心：

- 大型文生图。
- SDXL / Flux 本地推理。
- SupIR / CCSR 这类重型本地超分。
- CUDA-only 假设。
- 需要用户调 Python wheel 的模型链。

原则：

- 大生成走 API。
- 小辅助走 Rust + ONNX。
- 所有模型输出要回到同一套 mask / WorkingImage / grade pipeline。

当前运行时交付边界：

- 当前产品目标只覆盖 Windows x64；仓库锁定官方 ONNX Runtime 1.24.2 CPU
  基线并通过 Git LFS 只维护当前需要的 `onnxruntime.dll`。
- Rust 侧精确锁定兼容的 `ort` / `ort-sys`，使用动态加载，不保留
  `download-binaries` 或 HTTP/TLS 下载链。
- build、test、CI 和 Tauri 打包不得联网获取 ORT；维护者只能显式运行
  `scripts/fetch-onnxruntime.ps1` 更新已锁定的上游产物。
- 模型权重与 ORT 运行时分开管理；没有权重不能变成构建失败。
- CPU-only 是本阶段基线，不是永久限制。保留 provider 选择和设备请求合同，
  后续 Windows NVIDIA 走 CUDA，AMD/Intel 走 DirectML，ROCm 不作为 Windows 目标。
  `provider_shared` 不能单独提供兼容性；届时必须把 shared/专用 DLL、注册、打包、
  回退语义和真机测试作为同一个功能阶段加入。

## 7. 端到端集成优先级

### P0: 保持云端内核开发不冲突

当前如果云端正在写调色内核，本地不要改已有 kernel 代码和 `docs/design/grade-kernel.md`。
先用本文件固定集成边界即可。

### P1: FFmpeg 默认化 — ✅ 完成（Phase 7 收尾）

- ✅ native FFmpeg 是 desktop 唯一路径。
- ✅ PyAV 依赖已删除。
- ✅ trim / assemble / encode 已补齐。
- ✅ 视频帧直接进入 grade surface（`video_frame_grade_preview` / viewport `video_frame` target，无 PNG 中转）。

### P2: moxcms 全链路化

- 避免手工路径中间落成 8-bit sRGB。
- 所有手工节点优先消费 `WorkingImage`。
- 所有模型/API 只在边界做 sRGB egress。
- PSD / video / still export 使用同一色彩策略。

### P3: hgripe-grade 接入 — ✅ 完成

- ✅ 图片调色：`imageGrade` 节点（`studio/grade.rs::execute_studio_grade`）在 16-bit 工作面上全精度走内核；`grade_preview` 提供对话框实时预览（GPU 后端 `grade-gpu` 默认启用，CPU rayon 参考路径兜底）。
- ✅ 视频帧调色：`video_frame_grade_preview` 经 native FFmpeg 解码直接进内核；viewport host 的 `video_frame` / `video_clip` target 渲染时套用 grade doc；`timeline_export` 导出时逐帧全精度调色。
- ✅ temporal denoise：`TemporalAccumulator`（`studio/grade.rs`）已接入 viewport 渲染路径——连续播放时用上一帧 graded surface 做时域混合，seek / 换源自动重置。
- ✅ LUT、曲线、色轮、levels、blend mode 统一在 `GradeOp` op graph；`.cube` 可导入（`parse_cube`）也可导出（`bake_cube` 烘焙 3D LUT，空间 op 与 mask 按定义排除）。
- 剩余方向见 `docs/design/grade-kernel-roadmap.md`（halation/bloom、关键帧插值、GPU 帧序列导出渲染器等增强项）。

### P4: Rust PSD 子集 — ✅ 完成（Phase 7 收尾）

- ✅ inspect / analyze（`psd/analyze.rs`）。
- ✅ layered export（`psd/compose.rs` + `psd/write.rs`）。
- ✅ smart-object / placeholder replacement（`psd/smart.rs`）。
- ✅ `psd_tools` 已删除（golden 覆盖后，#314）。

### P5: ONNX 小模型辅助闭环

- ✅ 抠像和 matting 已闭环：Subject Mask 与 Refine Mask Edge 复用同一 Rust ViTMatte/ORT session。
- ✅ Windows x64 CPU ORT 已改为仓库锁定的动态运行时，构建与 CI 不再下载二进制。
- defect/detail watchdog 再闭环。
- ✅ 输出继续走现有 mask / grade / PSD / timeline 合同，缺权重时回落 CPU。

## 8. 判断一个库是否值得继续 fork

值得 fork 的标准：

- 它在运行时热路径上。
- 它影响画质、色彩、视频、PSD、导出稳定性。
- 上游升级可能破坏 H-Gripe 的生产合同。
- 你需要改源码来实现端到端能力。
- 它有 golden tests 能证明行为。

不值得 fork 的情况：

- 只是普通工具依赖。
- 只是构建时依赖。
- 没有 H-Gripe 特定修改。
- 不在热路径。
- 上游升级不影响产品输出。
- 没有测试覆盖，维护只靠感觉。

## 结论

最应该端到端集成：

1. `moxcms` - 色彩和 ProPhoto / CMYK / ICC 地基。
2. `ffmpeg` - 视频、时间线、帧缓存、导出地基。
3. `hgripe-grade` - 图片和视频统一调色地基（✅ 已集成）。
4. Rust PSD engine - PSD 生产交付地基。
5. ONNX / `ort` 小模型链 - 低成本本地辅助地基。

不应该端到端深挖：

1. `cargo-vendor` - 只做构建锁定。
2. ~~`psd_tools`~~ - 过渡使命完成，已删除（Phase 7）。
3. Python Torch / Diffusers - 不进入核心（相关 Python 插件引擎已随 Phase 7 删除）。

最终目标不是“仓库里有很多自维护库”，而是：

```text
source media
  -> Rust decode
  -> Rust colour-managed working surface
  -> Rust / ONNX local helper
  -> API generation when needed
  -> Rust grade / mask / compose / timeline
  -> Rust export
```

这才是 fork 和切断上游真正能转化为性能、稳定性和产品竞争力的地方。
