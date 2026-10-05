# GhostFleet Vision

> English and Chinese versions are separated to improve readability and review quality.

---

## 中文版

<!-- topic:reference -->



## 概述

GhostFleet 是一个面向 AI 原生设备舰队的开源控制平面。

最初目标是让聊天环境和 AI Agent 能够安全地与真实设备交互。GhostFleet 不把设备简单看作远程 Shell，而是建模为具有明确身份、能力、生命周期状态以及人工控制权限的节点。

核心模型：

```
AI Agent
   |
   v
能力层 Capability Layer
   |
   v
GhostFleet 控制平面
   |
   v
设备 Agent
```

GhostFleet 关注的是 AI Agent 与现实计算环境之间缺失的基础设施层。

## 定位

GhostFleet 不是传统远程桌面软件，也不是传统 RMM 替代品。

项目重点：

- 生命周期管理；
- Agent 通信协议；
- 能力模型；
- 安全授权；
- AI 集成。

## 品牌结构

仓库：

```
youling/ghostfleet
```

品牌：

```
GhostFleet
```

组件：

```
GhostFleet Control Plane
GhostFleet Agent
GhostFleet Console
GhostFleet Protocol
GhostFleet SDK
```

## 非目标

GhostFleet 不计划成为：

- 通用远程桌面产品；
- 封闭企业 MDM 平台；
- 重造已有成熟管理后台；
- 强绑定某一家云服务商的产品。

项目应尽可能复用成熟 UI 和控制面板生态，将工程投入集中在生命周期、协议、安全以及 AI 集成。

---


## English Version

<!-- topic:reference -->



## Overview

GhostFleet is an open-source AI-native device fleet control plane.

The original motivation is enabling AI agents inside chat and agent environments to safely interact with real-world devices. Instead of treating machines as remote shells, GhostFleet models devices as managed nodes with explicit identities, capabilities, lifecycle states, and human-controlled permissions.

Core model:

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

GhostFleet focuses on the missing infrastructure layer between AI agents and physical computing environments.

## Positioning

GhostFleet is not a traditional remote desktop product or RMM replacement.

The project focuses on:

- lifecycle management;
- agent communication protocols;
- capability models;
- security authorization;
- AI integration.

## Brand Structure

Repository:

```
youling/ghostfleet
```

Brand:

```
GhostFleet
```

Components:

```
GhostFleet Control Plane
GhostFleet Agent
GhostFleet Console
GhostFleet Protocol
GhostFleet SDK
```

## Non-goals

GhostFleet is not intended to become:

- a generic remote desktop product;
- a closed enterprise MDM platform;
- a replacement for existing mature admin dashboards;
- a provider-specific cloud product.

The project should reuse mature UI and control-plane ecosystems where possible and focus engineering effort on lifecycle, protocol, security, and AI integration.
