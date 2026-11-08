# mdview

mdview / mdpeek 桌面版的官方 VS Code 插件：在 VS Code 里写 Markdown，
**预览窗口边输入边无感刷新**——不用保存、不整页刷新，
光标和选区双向同步。

![VS Code + mdview 实时联动](https://mdview.cn/img/vscode-plugin.png)

## 为什么用它预览

- **无感刷新**：输入即推，连续输入时每 300ms 出一帧；预览按行级 diff
  原位换块，滚动位置、公式、图表状态都不丢——不是整页重载
- **双向同步**：移动 VS Code 光标，预览跟随滚动；点击预览正文，
  光标跳回源码行；预览里拖选文字，VS Code 同步选中（精确到字符）
- **完整渲染力**：表格、代码高亮、Mermaid 图表、KaTeX 公式、
  多套精美主题——mdview 桌面版的能力全部可用

## 前提

本插件自身不渲染 Markdown，需要配合桌面程序使用（协议一致，两版通用）：

- 国内版 mdview：https://mdview.cn
- 国际版 mdpeek（原 mdview 国际版，mdview.top 已 301 到 mdpeek.net）：
  https://www.mdpeek.net/download
- 实时推送为 **Pro** 功能

### 本机没装 mdview / mdpeek？

执行预览命令时若两者都未检测到，插件会提示并引导打开官网下载页，
下载安装 **Pro 版**后再次执行预览命令即可联动。

下载页自动分流：VS Code 界面语言为中文 → 国内版 mdview（mdview.cn），否则 →
国际版 mdpeek（mdpeek.net）。两版配置/付费/更新通道完全独立，打开的版本不对
可在设置里用 `mdview.channel` 手动指定。

## 使用

1. 打开任意 `.md` 文件，右键编辑区 → **在 mdview 中预览当前文件**
   （或命令面板执行同名命令），唤起 mdview 预览窗口；
2. 正常编辑即可，预览自动跟随；保存（Ctrl+S）不会触发整页刷新。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `mdview.path` | `""` | mdview / mdpeek 可执行文件路径，留空自动探测（Windows 优先取 .md 文件关联的打开方式，再走注册表 InstallDir、常见安装目录与 PATH） |
| `mdview.debounceMs` | `300` | 推送节流间隔（连续输入期间的出帧间隔） |
| `mdview.enabled` | `true` | 实时推送总开关 |
| `mdview.syncCursor` | `true` | 位置双向同步总开关 |
| `mdview.channel` | `"auto"` | 下载通道：`auto` = VS Code 界面语言中文装国内版 mdview、其余装国际版 mdpeek；可强制 `cn` / `intl` |
| `mdview.debugLog` | `false` | 排查用：往「mdview」输出通道写推送/光标/选区同步详细日志 |
