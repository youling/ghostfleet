# Standard MCP integration / 标准 MCP 集成

## 中文

<!-- topic:protocol -->
### 标准协议和客户端矩阵

`/mcp` 使用官方 MCP SDK 和无状态 Streamable HTTP JSON 响应。每次请求验证访问令牌；MCP、HTTP 与 Console 读取同一 Durable Object 快照。协议使用 POST 不授予变更权限；默认工具只读，核心无需 ChatGPT/OpenAI 配置。

| 客户端 | 路径 | 前提与限制 |
| --- | --- | --- |
| 标准 MCP SDK/客户端 | Streamable HTTP `/mcp` | 安全注入只读令牌；完成 initialize/list/call；无需 OpenAI 配置 |
| 通用 HTTP 客户端 | `/v0/*` 对象 | 服务端验证令牌、权限和 Origin；无需专有 AI 平台 |
| 可选类型化库消费者 | 显式包与后端 | 与 MCP 工具分离；可信策略、身份、传输与凭据由部署方配置 |
| 依赖 OAuth 的客户端，包括可选 ChatGPT 示例 | 可选授权适配器 | 基础模块不等于已部署 OAuth 服务；精确客户端、配置、重定向、权限和消费者另行验收 |

实际多客户端兼容由 SDK 初始化、工具发现与调用测试证明；两个身份标签不能代替两个真实客户端测试。

<!-- topic:tools -->
### 四个工具的参数与结果

| 工具 | 参数 | 结构化结果 |
| --- | --- | --- |
| `ghostfleet_list_nodes` | `{}` | `{nodes:[...]}`；包含 PROVISIONAL/ACTIVE，ACTIVE 表示本控制面的准入检查通过 |
| `ghostfleet_list_enrollment_attempts` | `{}` | `{attempts:[...]}`；持久状态、人工确认与证据摘要 |
| `ghostfleet_inspect_enrollment_attempt` | `{attempt_id:string}` | `{attempt:...}`；指定尝试的实际持久对象 |
| `ghostfleet_list_capabilities` | `{}` | `{capabilities:[...]}`；能力定义不执行命令 |

输入 schema 拒绝额外参数，未声明工具不注册。MCP 传输层校验输入；内部 dispatcher 不是绕过鉴权的公网入口。临时身份、能力声明或 ACTIVE 状态都不自行授予设备执行权限。

<!-- topic:client -->
### 通用 SDK 示例

独立消费者的目录、鉴权配置和调用路由须单独接线。在实际消费者验证身份发现、允许调用、越权拒绝和回滚后，才能宣称该消费者的端到端纳管或切换完成。详见 [迁移](MIGRATION.md)。

安装根依赖后，通过受保护环境注入只读令牌；不要把值放在命令参数、公开配置或日志。将示例保存为本机不提交的脚本，以 loopback 或已验证的 HTTPS `GHOSTFLEET_BASE_URL` 运行。

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const token = process.env.GHOSTFLEET_READ_TOKEN;
if (!token) throw new Error('READ_CREDENTIAL_REQUIRED');
const base = process.env.GHOSTFLEET_BASE_URL ?? 'http://127.0.0.1:8791';
const client = new Client({ name: 'standard-read-client', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  const tools = await client.listTools();
  const result = await client.callTool({ name: 'ghostfleet_list_nodes', arguments: {} });
  // Keep instance results private; do not dump inventory or credentials into public logs.
  if (tools.tools.length !== 4 || result.isError) throw new Error('MCP_READ_FAILED');
} finally { await client.close(); }
```

此示例不需要 OpenAI SDK 或配置，不连接设备，也不注册变更工具。

<!-- topic:errors -->
### 认证、错误和限制

缺少或错误令牌、跨 Origin 请求、额外参数、未知工具和未授权变更均拒绝。只读令牌允许 MCP 协议 POST，不允许对象 API 的变更操作。失败后先核对当前服务状态；只读操作可以重新观察，有副作用的能力不能按工具名称猜测或盲目重试。

参考访问令牌入口不是 OAuth 授权服务。可选基础模块支持 PKCE、重定向、DCR、所有者同意与令牌权限机制，但默认入口不自动部署客户端注册或登录。接入 OAuth 客户端前，单独配置 issuer、audience、精确重定向、客户端配置、权限范围和托管/撤销，并验收实际消费者。

## English

<!-- topic:protocol -->
### Standard protocol and client matrix

`/mcp` uses the official MCP SDK and stateless Streamable HTTP JSON responses. Each request validates a bearer; MCP/HTTP/Console read the same Durable Object snapshot. Protocol POST does not grant mutation authority. Default tools are read-only and core requires no ChatGPT/OpenAI configuration.

| Client | Path | Prerequisites and limits |
| --- | --- | --- |
| Standard MCP SDK/client | Streamable HTTP `/mcp` | Safely injected read bearer; initialize/list/call; no OpenAI configuration |
| Generic HTTP client | `/v0/*` objects | Server bearer/scope/Origin validation; no proprietary AI platform |
| Optional typed-library consumer | Explicit package/backend | Separate from MCP tools; trusted policy/actor/transport/credentials |
| OAuth-dependent clients, including optional ChatGPT examples | Optional authorization adapter | Generic helpers are not a deployed OAuth server; exact client/profile/redirect/scopes and consumer need separate acceptance |

Actual multi-client compatibility is established by SDK initialize/list/call tests, not by two userId labels pretending to be two AI clients.

<!-- topic:tools -->
### Four tools: arguments and results

| Tool | Arguments | Structured result |
| --- | --- | --- |
| `ghostfleet_list_nodes` | `{}` | `{nodes:[...]}`; includes PROVISIONAL/ACTIVE; only ACTIVE passed this control plane's admission checks |
| `ghostfleet_list_enrollment_attempts` | `{}` | `{attempts:[...]}`; durable states, gates and evidence summaries |
| `ghostfleet_inspect_enrollment_attempt` | `{attempt_id:string}` | `{attempt:...}`; the selected persisted attempt |
| `ghostfleet_list_capabilities` | `{}` | `{capabilities:[...]}`; definitions do not execute commands |

Schemas reject extra arguments and undeclared tools are not registered. The MCP transport validates input; its internal dispatcher is not an unauthenticated public bypass. PROVISIONAL status, capability presence or even ACTIVE status do not independently create platform execution authority.

<!-- topic:client -->
An independent consumer's catalog, authentication configuration and call routes are separate integrations. Verify identity discovery, permitted calls, unauthorized-operation rejection and rollback in the actual consumer before claiming its end-to-end admission or cutover. See [Migration](MIGRATION.md).

### Generic SDK example

After installing root dependencies, inject the read bearer into a protected environment; never put its value in command arguments, public configuration or logs. Save the following example in a local uncommitted script and run it with a loopback or validated HTTPS `GHOSTFLEET_BASE_URL`.

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const token = process.env.GHOSTFLEET_READ_TOKEN;
if (!token) throw new Error('READ_CREDENTIAL_REQUIRED');
const base = process.env.GHOSTFLEET_BASE_URL ?? 'http://127.0.0.1:8791';
const client = new Client({ name: 'standard-read-client', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  const tools = await client.listTools();
  const result = await client.callTool({ name: 'ghostfleet_list_nodes', arguments: {} });
  // Keep instance results private; do not dump inventory or credentials into public logs.
  if (tools.tools.length !== 4 || result.isError) throw new Error('MCP_READ_FAILED');
} finally { await client.close(); }
```

This example requires no OpenAI SDK/configuration, contacts no device and registers no mutation tools.

<!-- topic:errors -->
### Authentication, errors and limits

Missing/invalid bearers, cross-origin requests, extra arguments, unknown tools and unauthorized mutation are rejected. A read bearer permits protocol POST but not object API mutation. Check current server state after failure. Read operations can observe again, but clients cannot guess effect capabilities from tool names or blindly replay them.

The reference bearer endpoint is not an OAuth authorization server. Optional auth helpers may support generic PKCE/redirect/DCR/owner-consent/token-scope mechanisms, but the default endpoint does not automatically deploy client registration/login. OAuth-dependent clients require explicit issuer/audience/client redirect/profile/scopes, custody/revocation and actual consumer tests.
