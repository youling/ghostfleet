# GhostFleet Vision / GhostFleet 愿景

## Overview / 概述

GhostFleet is an open-source AI-native device fleet control plane.

GhostFleet 是一个面向 AI 原生设备舰队的开源控制平面。

The original motivation was enabling AI agents inside chat and agent environments to safely interact with real-world devices. Instead of treating machines as remote shells, GhostFleet models devices as managed nodes with explicit identities, capabilities, lifecycle states, and human-controlled permissions.

最初目标是让聊天环境和 Agent 环境中的 AI 能够安全地与真实设备交互。GhostFleet 不把设备简单视为远程 Shell，而是将设备建模为具备明确身份、能力、生命周期状态以及人工控制权限的受管理节点。

## Positioning / 定位

GhostFleet is not a traditional remote desktop or RMM replacement.

GhostFleet 不是传统远程桌面或 RMM（Remote Monitoring and Management）替代品。

The core model is:

```
AI Agent
   |
   v
Capability Layer
   |
   v
GhostFleet Control Plane
   |
   v
Device Agents
```

核心模型：

```
AI Agent
   |
   v
能力层
   |
   v
GhostFleet 控制平面
   |
   v
设备 Agent
```

The project focuses on the missing infrastructure layer between AI agents and physical computing environments.

项目关注的是 AI Agent 与现实计算环境之间缺失的基础设施层。

## Brand Structure / 品牌结构

Repository / 仓库:

```
youling/ghostfleet
```

Brand / 品牌:

```
GhostFleet
```

Components / 组件:

```
GhostFleet Control Plane
GhostFleet Agent
GhostFleet Console
GhostFleet Protocol
GhostFleet SDK
```

## Non-goals / 非目标

GhostFleet is not intended to become:

GhostFleet 不计划成为：

- a generic remote desktop product;
- 通用远程桌面产品；
- a closed enterprise MDM platform;
- 封闭式企业 MDM 平台；
- a replacement for existing admin dashboards;
- 重新实现已有成熟管理后台；
- a provider-specific cloud product.
- 绑定单一云厂商的产品。

The project should reuse mature UI/control-panel ecosystems where possible and focus engineering effort on lifecycle, protocol, security, and AI integration.

项目应尽可能复用成熟 UI/控制面板生态，将工程资源集中在生命周期、协议、安全模型以及 AI 集成上。
