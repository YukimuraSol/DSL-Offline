<div align="center">

<img src="public/launcher-logo.png" alt="DSL Offline" width="120" />

# DSL Offline

**面向 DeepSeek Harness 的 Windows 整合包启动器**

一个 exe，装完就能用。整合包自带内核，导入即跑，拔了网络也能开。

<br />

[![Electron](https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?style=flat-square&logo=windows&logoColor=white)](#)

</div>

---

## 这是什么

把 DeepSeek Harness（DSH）的部署、插件管理、实例启停收进一个图形界面。

只做两件事：**整合包** 和 **启动**。

## 核心概念

**整合包** 是一套完整的 DSH 环境，不是一份配置。

```
整合包 = 内核 + 插件 + 附件 + 配置 + 会话
```

每个整合包拥有**独立的 DSH Home**，彼此不共享任何东西。装两个包，就是两个互不干扰的环境，可以同时运行在不同端口上。

包里分三类东西：

| 类别 | 是什么 |
| --- | --- |
| **核心** | DSH 内核本体 |
| **插件** | 给 DSH 加能力的扩展 |
| **附件** | 整合包附带的文件：技能、预设、图标、素材 |

## 整合包自带内核

这是和常见启动器最不一样的地方。

内核**跟着包走**，不是跟着启动器走。同一个启动器可以同时跑 0.2.1 的包和 0.3.0 的包，互不影响。

只有包里没带内核时，才回落到启动器安装的那一份。界面上的「内核已就绪」会写明当前用的哪一份、从哪来。

## 关键能力

- **导入即用** —— 导入 `.zip` 整合包，自动解压、校验、装好，不需要预先安装 Node 或 DSH
- **离线可用** —— 安装包内自带 Node 运行时，断网也能完成导入和启动
- **多包并行** —— 每个包一个端口，同时运行多个实例；端口被占时可以选择处置方式
- **实例托管** —— 启动、停止、看日志都在界面里；**退出启动器不会关掉正在运行的实例**
- **导出可搬家** —— 把整个环境打包成 `.zip`，换台机器导入就能接着用

## 安装

从 Releases 下载 `DSL-Offline-<版本>-setup.exe`，双击安装。

装完打开，点「导入整合包」选择 `.zip`，或新建一个空白实例。

## 从源码构建

```bash
npm install
npm run dev          # 开发模式
npm run build        # 类型检查 + 打包前端
npm run package:inno # 出安装包
```

> 打包时 electron-builder 需要下载 Electron 二进制。如果卡在下载，设一个镜像：
>
> ```powershell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> ```

## 目录

```
electron/        主进程：实例、整合包、端口、安装
src/             渲染层：两个页面（启动 / 整合包）
src/components/  界面组件
src/views/       页面级视图
tests/           单元测试
build/           安装器脚本
scripts/         打包、导出、运行时抓取
```

## 已知限制

- 仅 Windows x64
- 内核数据格式只能升不能降，要试旧版本请复制一个新包
- 官方桌面端只开放安装与卸载接口，启动器这边也做不了启用/停用

## 说明

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建，起步时参考过社区里的启动器实现，之后在整合包模型、实例隔离、离线导入等方向做了大量重写，现在是一套独立的实现。

问题与建议请开 Issue。
