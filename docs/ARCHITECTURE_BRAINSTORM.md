# GhostFleet Architecture Brainstorm / GhostFleet 架构头脑风暴

Status: Draft for Astra review

状态：提交 Astra 架构审查草案

## 1. Core Principle / 核心原则

GhostFleet should be designed around lifecycle and objects, not isolated tasks.

GhostFleet 应围绕对象和生命周期设计，而不是围绕孤立任务设计。

Avoid / 避免：

```
Create a new issue for every feature
```

每个功能创建一个新对象。

Prefer / 推荐：

```
Existing GhostFleet object
        |
        + capability added
        + lifecycle state changed
        + new domain introduced
```

已有 GhostFleet 对象：

```
已有对象
        |
        + 增加能力
        + 生命周期状态变化
        + 引入新领域
```

## 2. High-level Architecture / 高层架构

```
                    Human
                      |
                      v
              GhostFleet Console
                      |
       +--------------+--------------+
       |              |              |
 Enrollment      Fleet Domain   Capability
  Domain                          Domain
       |              |              |
       +--------------+--------------+
                      |
              Control Plane
                      |
              Device Agents
```

## 3. Single Entry Point, Multiple Domains / 单入口，多领域

Enrollment and daily management should not become separate products.

设备入列和日常管理不应该成为两个独立产品。

Preferred / 推荐：

```
app.ghostfleet.dev

Fleet
 ├── Dashboard
 ├── Nodes
 ├── Enrollment
 ├── Capabilities
 ├── Events
 └── Settings
```

The separation is a security/service boundary, not a user experience boundary.

分离的是安全边界和服务边界，而不是用户体验入口。

## 4. Node Lifecycle / 节点生命周期

```
UNKNOWN
   |
ENROLLMENT_PENDING
   |
PROVISIONAL
   |
ACTIVE
   |
SUSPENDED
   |
RETIRED
```

Enrollment is part of the node lifecycle.

Enrollment 属于节点生命周期的一部分，而不是独立产品。

## 5. Security Model / 安全模型

Important distinction:

重要区别：

```
Bootstrap identity != operational authority
```

引导身份 != 运行权限。

A new device may receive enough authority to register itself, but should not automatically receive unrestricted execution capability.

新设备可以获得完成注册所需的权限，但不应该自动获得无限制执行能力。

Conceptually / 概念流程：

```
Enrollment Token
        |
        v
Node Identity
        |
        v
Capability Grants
        |
        v
Approved Operations
```

Human Gate is required for sensitive capability issuance.

敏感能力授予需要 Human Gate。

## 6. Control Plane Components / 控制平面组件

Initial conceptual modules / 初始模块：

```
Control Plane
 |
 +-- Enrollment Service
 |
 +-- Fleet Service
 |
 +-- Capability Service
 |
 +-- Event Service
 |
 +-- API Layer
```

## 7. UI Strategy / UI 策略

Do not build a complete custom admin UI from zero.

不要从零重新开发完整后台管理 UI。

Reuse mature UI/control-panel ecosystems where practical.

尽可能复用成熟 UI 和控制面板生态。

GhostFleet differentiation is:

GhostFleet 的差异化在于：

- protocol;
- 协议；
- agent runtime;
- Agent 运行时；
- lifecycle model;
- 生命周期模型；
- capability security;
- 能力安全模型；
- AI integration.
- AI 集成。

Potential UI model / UI 模型：

```
GhostFleet API
      |
      +-- Official Console
      +-- Community Plugins
      +-- External Dashboards
```

## 8. Initial Capability Targets / 初始能力目标

Supported platforms explored / 已探索平台：

- Linux
- Windows
- Android
- macOS (future / 未来)

Initial capabilities / 初始能力：

- shell/command execution;
- Shell/命令执行；
- file operations;
- 文件操作；
- system information;
- 系统信息；
- container operations;
- 容器操作；
- browser/device automation where supported.
- 支持情况下的浏览器和设备自动化。

## 9. Integration Direction / 集成方向

Primary AI integration should be capability-oriented.

AI 集成应该以能力为核心抽象。

```
AI Agent
   |
   +-- MCP
   +-- API
   +-- SDK
   |
GhostFleet
```

Avoid exposing raw remote shell as the primary abstraction.

避免将裸远程 Shell 作为主要抽象。
