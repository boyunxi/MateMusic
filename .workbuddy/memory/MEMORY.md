# MateMusic 项目长期笔记

## 项目定位

正式名称 **MateMusic**；英文标准写法固定，包名 / 应用标识符统一使用小写 `matemusic`，避免与 Meta 拼混。

Windows 桌面端、纯本地、高保真音乐播放器。全程离线可用，音频源文件只读，不上传、不遥测。

## 命名决策

- 由 MeatMusic 更名而来。Mate（伙伴 / 陪伴）比 Meat 更贴合本地音乐播放器，且避免中文语境下「肉音乐」的直译歧义。
- 已知风险：HUAWEI Mate 系列品牌联想；Mate / Meta 仅差一个字母，口述、搜索、域名与包名易混淆。故固定小写标识符 `matemusic`。

## 已定技术路线

- Tauri 2 + React + TypeScript + Vite；WebView 只做展示，解码 / 播放时钟 / 设备输出全部在 Rust 核心。
- 解码底座：Symphonia（首期，纯 Rust）+ FFmpeg（M3 补齐 APE / WMA / DSD，LGPL 动态链接）；统一 `Decoder` 抽象。
- WASAPI 共享 / 独占为主，ASIO 可选；`atempo` 实现保持音调的倍速（M3 随 FFmpeg 引入）。
- SQLite（`rusqlite`）+ `lofty` 元数据 + `notify` 目录监控；前端 Zustand、`@tanstack/react-virtual`、Motion、原生 CSS 设计令牌。
- 倍速必须维护输出时间轴 → 源时间轴映射，保证歌词与 CUE 分轨不漂移。

## 产品约定

- 视觉：磨砂玻璃质感，深色沉浸为默认，另备浅色玻璃主题；动效克制，支持 `prefers-reduced-motion`。
- 音质诚实：界面展示源文件 / 解码 / 设备输出三段参数；无法验证 Bit-Perfect 时不显示该标记。
- 范围边界：标准非加密格式；首期不做原生 DSD / DoP、NAS、云同步、在线歌词；加密歌词格式预留 `LyricParser` 适配器接口。
- 倍速、EQ、音量 DSP 与 Bit-Perfect 物理互斥，走两条独立输出链路。

## 工程流程

- 根目录双文档：`PLAN.md`（全局规划与技术架构）、`PROGRESS.md`（任务分解与实时进度）。
- 每完成一个独立功能点，立即更新 `PROGRESS.md` 并执行一次原子 `git commit`；Conventional Commits。
- 后端用命令行 / 测试脚本闭环验证；前端保证 `typecheck` / `lint` / `build` 全绿，交互与视觉由用户验收。
- `.workbuddy/` 为项目工作数据，不得删除。
