# GhostFleet V0 MCP Surface

## 中文版

V0 MCP 先把 AI 放在“观察对象与状态”的位置，而不是直接把节点变成万能终端。

当前工具：

- `ghostfleet_list_nodes`
- `ghostfleet_list_enrollment_attempts`
- `ghostfleet_inspect_enrollment_attempt`
- `ghostfleet_list_capabilities`

这些工具都是 inspection surface。现在通过标准 Streamable HTTP `/mcp` 提供，使用官方 MCP SDK、stateless JSON response 和与 HTTP API 相同的 Durable Object snapshot。每次请求均验证 bearer；read-only 凭据可发送 MCP POST，但无法通过 MCP 调用 mutation。

节点列表包含 MATERIALIZING 期间的 PROVISIONAL 身份，Console、HTTP 和 MCP 读取同一个 node_uid。PROVISIONAL 不等于 ACTIVE，不授予 operational authority。

支持 bearer 配置的客户端（例如 Codex CLI）可以连接部署后的 HTTPS 地址：

```sh
codex mcp add ghostfleet --url https://YOUR-WORKER-HOST/mcp --bearer-token-env-var GHOSTFLEET_READ_TOKEN
```

凭据通过运行环境安全注入，不放在命令行或配置值中。该命令参数已通过云端 Codex CLI help 核对；真实远端连接需部署后验证。ChatGPT 等要求 OAuth 的连接流程仍需要单独的 OAuth 授权集成，当前 bearer transport 不冒充 OAuth server。部署步骤见 [Cloudflare deployment](DEPLOYMENT.md)。

未来 mutation surface 的约束：

1. exact node identity 必须由 server-side projection 决定；
2. capability scope 必须显式；
3. R1/R2 policy/HumanGate 由服务端执行；
4. operation receipt/evidence 必须可追踪；
5. tool description/annotation 只服务 UX，不作为 authority。

---

## English Version

V0 MCP deliberately puts the AI in an object/state inspection role before exposing mutation authority.

Current tools:

- `ghostfleet_list_nodes`
- `ghostfleet_list_enrollment_attempts`
- `ghostfleet_inspect_enrollment_attempt`
- `ghostfleet_list_capabilities`

All current tools are inspection surfaces, served by the official SDK over authenticated stateless Streamable HTTP at `/mcp`. MCP and the REST API read the same Durable Object snapshot. A read-only bearer permits protocol POST requests but never enables mutation tools.

The node list includes PROVISIONAL identities during MATERIALIZING. Console, HTTP and MCP read the same node_uid. PROVISIONAL is not ACTIVE and grants no operational authority.

Bearer-capable clients can connect using the command above once the Worker is deployed. OAuth-dependent client connection flows require a separate OAuth authorization integration; this bearer endpoint does not implement an OAuth server.

Future mutation surfaces must satisfy these constraints:

1. exact node identity is selected by server-side projection;
2. capability scope is explicit;
3. R1/R2 policy/HumanGate enforcement is server side;
4. operation receipts/evidence are traceable;
5. tool descriptions/annotations are UX metadata, not authority.
