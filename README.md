# operit-context-dashboard

**上下文仪表盘 for Operit** —— 把 Operit 每轮发给模型的提示词做成一块可视化仪表盘。

> An unofficial port of the [dsh-context](https://github.com/bowenliang123/dsh-context) dashboard to the [Operit](https://github.com/AAswordman/Operit) platform.
>
> **特别感谢 [@bowenliang123](https://github.com/bowenliang123) 和 dsh-context 项目——这个移植版建立在他们的设计与代码之上。**
>
> Thanks to [@bowenliang123](https://github.com/bowenliang123) for the original [dsh-context](https://github.com/bowenliang123/dsh-context) project. See Credits below.

## 功能

- **上下文统计** —— 轮次 / 步骤 / 工具调用 / 缓存命中
- **上下文构成** —— 环形图 + 组成明细（系统 / 技能 / 世界书 / 资料 / 总结 / 工具 / 消息）
- **当前上下文** —— 堆叠条 + 图例
- **上下文趋势** —— 每轮 token 趋势、点柱看该轮详情（本轮/输入/回复三行·点击直达）、✂ 压缩事件标记、跳过明细（系统警告对拍）
- **上下文浏览器** —— 按分类（系统提示词 / 技能注入 / 世界书 / 用户资料 / 对话总结 / 工具定义 / 消息历史）逐段查看原始内容
- **上下文事件** —— 上下文压缩（总结触发）、模型切换与系统警告（报错，可点击直达原文）
- **文件活动** —— 从工具调用解析出的文件读写记录
- **工具使用** —— 本会话工具调用排行
- **Token 统计（计费）** —— 会话计费口径：Σ输入+输出，输入按构成分摊（≈）、输出为真值
- **估算花费** —— 按内置价格表估算
- **世界书** —— 本轮注入的条目一览
- 卡名显示、主题持久化

## 工作原理

- **采集层**（`toolpkg/dist/main.js`）：挂在 Operit 的 `prompt_finalize` 钩子上，把真正发给模型的提示词逐字落盘（raw / meta / 每轮快照 / 系统警告实录）。**纯本地，零外传**。
- **仪表盘**（`toolpkg/dist/ui/dashboard/index.ui.js` + `assets/index.single.html`）：在侧边栏「上下文仪表盘」入口打开 WebView，读取本地数据渲染。

数据保留策略：会话数据环形保留最近 100 个对话，日志文件保留最近 14 天，自动清理。

## 安装

1. 把 `toolpkg/` 目录打包为 `.toolpkg`（或使用 Operit 的调试安装能力）安装、启用；
2. 把 `assets/boot.html` 和 `assets/index.single.html` 放到：
   `/sdcard/Download/Operit/projects/dsh-context-port/preview/`
3. 退出重进 Operit，从侧边栏拉出「上下文仪表盘」。

## 从源码构建 Web UI

```sh
cd web
npm install
npm run build
```

构建产物经 `inline.mjs` 内联为单文件 HTML（`index.single.html`），复制到上面的 assets 路径即可。

## 设计与重建文档

完整的架构说明、数据结构（字段级 schema）、桥协议、全部关键算法与已知坑清单见 **[DESIGN.md](DESIGN.md)**——可作为从零复刻该插件的完整重建指南。

## Credits & License

- **Made with ♥ by 梦新 & Viya.**
- UI 设计与部分代码**衍生自 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)**（Apache-2.0），已为 Operit 平台做大量修改；修改过的文件在文件头有标注。
- UI 主题样式参考 dsh 客户端主题（**MIT License, Copyright (c) 2026 DeepSeek**，来自 [@deepseek-ai/dsh-client-ui-primitives](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-primitives)）；完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 本项目为**非官方**移植，与 dsh-context、DeepSeek、Operit 官方均无隶属关系。
- 本仓库以 [Apache-2.0](LICENSE) 发布。
