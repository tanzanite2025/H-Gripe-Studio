# Vendored Runtime End-to-End Integration Plan

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
| `third_party/psd_tools` | Python PSD 过渡库 | 不建议长期深度投入 | 作为参考实现，最终迁到 Rust PSD 子集 |
| `third_party/cargo-vendor` | Cargo 依赖快照 | 不适合业务集成 | 只做离线构建和版本锁定 |
| `crates/hgripe-api` | API 调用 crate | 是，但属于业务协议层 | 保持干净，和本地像素内核分离 |
| future `crates/hgripe-grade` | 调色 / 合成内核 | 是，极高价值 | 统一图片和视频调色 |
| ONNX / `ort` 模型路径 | 本地小模型辅助 | 是，选择性集成 | 抠像、matting、检测、轻量 harmonize |

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

当前不理想的状态：

- native FFmpeg 还是 feature path。
- PyAV / Python 仍然是 fallback。
- trim / assemble 仍容易被 Python worker 牵住。
- 解码帧如果大量落盘为 PNG，会损失端到端性能。

长期目标：

- desktop 默认启用 native FFmpeg。
- 移除 PyAV 作为正常运行路径。
- 对视频帧建立内存级 frame buffer / cache。
- 调色和剪辑直接消费 Rust 解码帧，而不是临时文件。

## 3. psd_tools: 只作为过渡和参考

`third_party/psd_tools` 当前有价值，因为 PSD 很复杂，它能让现有 PSD 节点先跑起来。

但它不适合继续深度端到端扩展，原因：

- 它是 Python 库，和零 Python runtime 目标冲突。
- PSD 处理如果继续堆在 Python 上，未来 Rust 内核和 Python PSD 会分裂。
- 性能热点会被进程边界、Pillow/numpy、文件中转限制住。

正确用法：

- 用它生成 PSD golden fixtures。
- 用它对照真实 PSD 结构。
- 用它保留现有功能直到 Rust PSD 子集完成。

长期替代：

```text
PSD template
  -> Rust PSD inspect / analyze
  -> layer bounds / masks / placeholders
  -> Rust pixel compose
  -> Rust PSD / PSB export
  -> Photoshop cleanup compatible output
```

Rust PSD 不需要一开始完整覆盖 Photoshop 全格式。优先做 H-Gripe 生产需要的子集：

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

## 5. hgripe-grade: 应该成为图片和视频的统一调色内核

未来的 `crates/hgripe-grade` 值得端到端集成，因为它连接图片、PSD、视频、手工编辑和导出。

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

## 7. 端到端集成优先级

### P0: 保持云端内核开发不冲突

当前如果云端正在写调色内核，本地不要改已有 kernel 代码和 `docs/design/grade-kernel.md`。
先用本文件固定集成边界即可。

### P1: FFmpeg 默认化

- native FFmpeg 从 feature path 变成 desktop 默认路径。
- 去掉正常运行里的 PyAV 依赖。
- 补齐 trim / assemble / encode。
- 确保视频帧能进入未来 grade surface。

### P2: moxcms 全链路化

- 避免手工路径中间落成 8-bit sRGB。
- 所有手工节点优先消费 `WorkingImage`。
- 所有模型/API 只在边界做 sRGB egress。
- PSD / video / still export 使用同一色彩策略。

### P3: hgripe-grade 接入

- 图片调色先接。
- 视频帧调色再接。
- LUT、曲线、色轮、levels、blend mode 统一。

### P4: Rust PSD 子集

- 先 inspect / analyze。
- 再 layered export。
- 最后 smart-object / placeholder replacement。
- 删除 `psd_tools` 前必须有真实 PSD 模板 golden。

### P5: ONNX 小模型辅助闭环

- 抠像和 matting 先闭环。
- defect/detail watchdog 再闭环。
- 输出直接进 mask / grade / PSD / timeline。

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
3. future `hgripe-grade` - 图片和视频统一调色地基。
4. Rust PSD engine - PSD 生产交付地基。
5. ONNX / `ort` 小模型链 - 低成本本地辅助地基。

不应该端到端深挖：

1. `cargo-vendor` - 只做构建锁定。
2. `psd_tools` - 只做 Python 过渡和参考实现。
3. Python Torch / Diffusers - 不进入核心，最多外部插件化。

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
