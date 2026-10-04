# GhostFleet

> Open-source AI-native device fleet control plane.

## 中文版

GhostFleet 让 AI Agent 和 Human 通过统一的生命周期、能力和权限模型管理真实设备，而不是把设备降级成“一个远程 Shell”。

项目源自 `youling/fleet` 的真实设备纳管与远控实践，并从私有实例中抽取为独立公共产品。

### 核心模型

~~~text
Human / AI Agent
       |
       v
GhostFleet Console / MCP / API
       |
       v
Capability + Lifecycle Control Plane
       |
       v
Device Agents / Provider Adapters
       |
       v
Linux / Windows / Android / future Apple devices
~~~

### V0 原则

- **单入口，多 Domain**：Enrollment 和日常管理共享一个 Console；安全边界在服务/权限层隔离。
- **生命周期优先**：EnrollmentAttempt、HumanGate、Evidence、NodeIdentity 是一等对象。
- **证据驱动**：命令成功不等于节点完成纳管。
- **Capability 优先**：AI 请求受限能力，不直接持有 fleet-wide credential。
- **Human Gate**：敏感能力通过明确、持久化的人工批准状态。
- **事件驱动**：AI 不充当高频轮询 daemon。
- **Provider-neutral core**：Cloudflare 是参考部署，不是协议依赖。
- **复用 UI**：官方 Console V0 使用 Tabler 开源 UI 基础，不重新设计一套后台组件。

### 当前首版范围

首个纵切已经覆盖 EnrollmentAttempt → HumanGate → Evidence → Node admission → Capability Registry → Events。

AI 集成当前只开放观察/检查类 typed MCP 工具。高权限设备执行适配保持为独立 adapter contract，在真实 canary 和安全审查后接入，不把任意 exec 作为公共首版的默认能力。

### 开发

需要 Node.js 22+。

~~~bash
npm ci
npm test
npm run check
npm run build:console
npm run dev:init
npm run verify:cloud
~~~

许可证为 **AGPL-3.0-only**。云端开发、启动及验收见 [Cloud development](docs/CLOUD_DEVELOPMENT.md)。Console 使用单独的控制面凭据，不使用 provider/device 凭据。

> V0 仍处于实施阶段。正式发布前仍需真实 Linux canary、第二独立节点 canary和威胁模型复审。

---

## English Version

GhostFleet lets AI agents and humans manage real devices through a shared lifecycle, capability, and authority model instead of reducing machines to remote shells.

The project is extracted from real enrollment and remote-control work in the private `youling/fleet` repository and rebuilt as an independent public product.

### Core model

~~~text
Human / AI Agent
       |
       v
GhostFleet Console / MCP / API
       |
       v
Capability + Lifecycle Control Plane
       |
       v
Device Agents / Provider Adapters
       |
       v
Linux / Windows / Android / future Apple devices
~~~

### V0 principles

- **Single entry point, multiple domains**: enrollment and daily management share one Console; authority boundaries live below the UX layer.
- **Lifecycle first**: EnrollmentAttempt, HumanGate, Evidence, and NodeIdentity are first-class objects.
- **Evidence driven**: command success is not enrollment success.
- **Capability first**: AI requests bounded capabilities instead of holding fleet-wide credentials.
- **Human Gate**: sensitive authority becomes an explicit durable approval state.
- **Event driven**: the AI is not a high-frequency polling daemon.
- **Provider-neutral core**: Cloudflare is a reference deployment, not a protocol dependency.
- **Reuse UI**: the official V0 Console uses the open-source Tabler UI foundation instead of inventing another admin design system.

### Current first implementation

The initial vertical slice covers EnrollmentAttempt → HumanGate → Evidence → Node admission → Capability Registry → Events.

The AI integration currently exposes observation/inspection typed MCP tools only. High-authority device execution remains behind a separate adapter contract until live canaries and security review; arbitrary exec is not a default public V0 capability.

### Development

Node.js 22+ is required.

~~~bash
npm ci
npm test
npm run check
npm run build:console
npm run dev:init
npm run verify:cloud
~~~

Licensed under **AGPL-3.0-only**. See [Cloud development](docs/CLOUD_DEVELOPMENT.md) for startup and validation. Console credentials are separate from provider/device credentials.

> V0 is under active implementation. Production release still requires a live Linux canary, an independent second-node canary, and threat-model review.
