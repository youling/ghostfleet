# GhostFleet V0 MCP Surface

## 中文版

V0 MCP 先把 AI 放在“观察对象与状态”的位置，而不是直接把节点变成万能终端。

当前工具：

- `ghostfleet_list_nodes`
- `ghostfleet_list_enrollment_attempts`
- `ghostfleet_inspect_enrollment_attempt`
- `ghostfleet_list_capabilities`

这些工具都是 inspection surface。

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

All current tools are inspection surfaces.

Future mutation surfaces must satisfy these constraints:

1. exact node identity is selected by server-side projection;
2. capability scope is explicit;
3. R1/R2 policy/HumanGate enforcement is server side;
4. operation receipts/evidence are traceable;
5. tool descriptions/annotations are UX metadata, not authority.
