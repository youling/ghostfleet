# GhostFleet Architecture Brainstorm

Status: `HISTORICAL_BRAINSTORM` — implementation baseline is `docs/ARCHITECTURE.md`

> 本文保留早期头脑风暴记录。当前实施以 `docs/ARCHITECTURE.md` 为准。中文与英文版本继续分离，避免交错阅读。

---

# 中文版

## 1. 核心原则

GhostFleet 应围绕生命周期和对象设计，而不是围绕孤立任务设计。

避免：

```
每个功能创建一个新的管理对象
```

采用：

```
已有 GhostFleet 对象
        |
        + 新增能力
        + 生命周期变化
        + 新领域扩展
```

## 2. 总体架构

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

## 3. 单入口，多 Domain

Enrollment 和日常管理不应该成为两个产品。

推荐：

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

区别应该体现在安全和服务边界，而不是用户入口。

## 4. 节点生命周期

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

Enrollment 是节点生命周期的一部分。

## 5. 安全模型

关键区别：

```
Bootstrap Identity != Operational Authority
```

设备可以获得注册自身的能力，但不应该自动获得无限执行权限。

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

敏感能力需要 Human Gate。

## 6. 控制平面模块

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

## 7. UI 策略

不要从零开发完整后台。

优先复用成熟开源 Dashboard/Admin 生态。

GhostFleet 的核心价值：

- 协议；
- Agent Runtime；
- 生命周期模型；
- 能力安全；
- AI 集成。

UI 作为 API 的消费者：

```
GhostFleet API
      |
      +-- Official Console
      +-- Community Plugins
      +-- External Dashboards
```

## 8. 初始能力目标

支持平台：

- Linux
- Windows
- Android
- macOS（未来）

初始能力：

- Shell/命令执行；
- 文件操作；
- 系统信息；
- 容器操作；
- 浏览器和设备自动化。

## 9. AI 集成方向

采用能力导向：

```
AI Agent
   |
   +-- MCP
   +-- API
   +-- SDK
   |
GhostFleet
```

避免将裸 Shell 作为主要抽象。

---

# English Version

## 1. Core Principle

GhostFleet should be designed around lifecycle and objects, not isolated tasks.

Prefer evolving existing objects through:

- added capabilities;
- lifecycle changes;
- new domains.

## 2. High-level Architecture

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

## 3. Single Entry Point, Multiple Domains

Enrollment and daily management should not become separate products.

Preferred:

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

## 4. Node Lifecycle

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

## 5. Security Model

Important distinction:

```
Bootstrap Identity != Operational Authority
```

A device may receive enough authority to register itself, but should not automatically receive unrestricted execution capability.

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

Sensitive capabilities require Human Gate approval.

## 6. Control Plane Components

```
Control Plane
 |
 +-- Enrollment Service
 +-- Fleet Service
 +-- Capability Service
 +-- Event Service
 +-- API Layer
```

## 7. UI Strategy

Do not build a complete custom admin UI from zero.

Reuse mature open-source dashboard/admin ecosystems where practical.

GhostFleet differentiation:

- protocol;
- agent runtime;
- lifecycle model;
- capability security;
- AI integration.

UI should be an API consumer:

```
GhostFleet API
      |
      +-- Official Console
      +-- Community Plugins
      +-- External Dashboards
```

## 8. Initial Capability Targets

Supported platforms:

- Linux
- Windows
- Android
- macOS (future)

Initial capabilities:

- shell/command execution;
- file operations;
- system information;
- container operations;
;
- browser and device automation.

## 9. AI Integration Direction

Use capability-oriented integration:

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
