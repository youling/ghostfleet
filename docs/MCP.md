# Standard MCP integration / 标准 MCP 集成

## 中文

<!-- topic:protocol -->
### 标准协议和客户端矩阵

`/mcp`使用officialMCP SDK与stateless StreamableHTTP JSONresponse；每个request验证bearer，MCP/HTTP/Console读同一个DurableObjectsnapshot。协议POST不等于mutationauthority；defaulttools只读。核心不要求ChatGPT/OpenAI配置。

| 客户端 | 路径 | 前提与限制 |
| --- | --- | --- |
| StandardMCP SDK/client | StreamableHTTP `/mcp` | readbearer安全注入；initialize/list/call；无OpenAI配置 |
| GenericHTTPclient | `/v0/*` objects | serverbearer/scope/Origin验证；不经过专有AI平台 |
| Optionaltyped library consumer | explicitpackage/backend | 与MCP工具分离；trustedpolicy/actor/transport/credentials |
| OAuth依赖client（包含可选ChatGPT例子） | optionalauthorization adapter | generichelper≠已部署OAuthserver；exactclient/profile/redirect/scopes及消费者另行验收 |

实际多client兼容由SDK初始化/list/call测试证明，不把两个userId标签当成两个AI客户端测试。

<!-- topic:tools -->
### 四个工具的参数与结果

| 工具 | 参数 | 结构化结果 |
| --- | --- | --- |
| `ghostfleet_list_nodes` | `{}` | `{nodes:[...]}`；含PROVISIONAL/ACTIVE，ACTIVE才通过admission |
| `ghostfleet_list_enrollment_attempts` | `{}` | `{attempts:[...]}`；durablestate/gates/evidencesummary |
| `ghostfleet_inspect_enrollment_attempt` | `{attempt_id:string}` | `{attempt:...}`；指定attempt的实际对象 |
| `ghostfleet_list_capabilities` | `{}` | `{capabilities:[...]}`；capabilitydefinitions不执行命令 |

input schema拒extraarguments；undeclaredtool不注册。MCPtransport负责validate，内部dispatcher不是可绕过authenticatedingress的公网入口。PROVISIONAL、capabilitypresence或NodeACTIVE都不自行创建platformexecution权限。

<!-- topic:client -->
### Generic SDK 示例

安装rootdependencies后，在受保护环境设置readbearer变量；不要把值写在commandline、publicconfig或日志。将下面示例保存到本机未提交script后运行，`GHOSTFLEET_BASE_URL`使用本机loopback或已验HTTPS地址。

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

此示例不需OpenAI SDK/config、不会连接设备或注册mutation。

<!-- topic:errors -->
### 认证、错误和限制

缺失/invalidbearer、crossOrigin、额外参数、unknown tool和未经授权mutation均拒绝。Readbearer允许MCP协议POST，不允许对象API mutation。请求失败先检查currentserverstate；readoperation可重新观察，但有副作用能力不能通过MCP工具名猜测或blindretry。

referencebearer不是OAuthauthorizationserver。Optionalauthhelpers可支持genericPKCE/redirect/DCR/ownerconsent/token-scope机制，但默认endpoint没有自动部署clientregistration/login。接OAuth-dependentclient前需单独配置exactissuer/audience/clientredirect/profile/scopes、custody/revoke与真实consumer测试。

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
| `ghostfleet_list_nodes` | `{}` | `{nodes:[...]}`; includes PROVISIONAL/ACTIVE; only ACTIVE passed admission |
| `ghostfleet_list_enrollment_attempts` | `{}` | `{attempts:[...]}`; durable states, gates and evidence summaries |
| `ghostfleet_inspect_enrollment_attempt` | `{attempt_id:string}` | `{attempt:...}`; the selected persisted attempt |
| `ghostfleet_list_capabilities` | `{}` | `{capabilities:[...]}`; definitions do not execute commands |

Schemas reject extra arguments and undeclared tools are not registered. The MCP transport validates input; its internal dispatcher is not an unauthenticated public bypass. PROVISIONAL status, capability presence or even ACTIVE status do not independently create platform execution authority.

<!-- topic:client -->
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
