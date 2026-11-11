/**
 * Optional ChatGPT MCP Apps Phase 0 probe.
 *
 * The public typed-control core remains AI-client-neutral. Consumers must
 * opt in to this compatibility adapter; importing it does not register tools,
 * grant scopes, access any credentials or dispatch a privileged operation.
 */
export const APPROVAL_PHASE0_URI = "ui://ghostfleet/admin-approval-phase0/v1.html";
export const APPROVAL_PHASE0_MIME = "text/html;profile=mcp-app";
export const APPROVAL_PHASE0_TOOL = "fleet_admin_ui_probe";
export const APPROVAL_PHASE0_SCOPE = "fleet.privileged.approve";

export function chatgptApprovalPhase0ProbeHtml(): string {
  // Static HTML only, no request/credential/state interpolation. The probe
  // does not contain approval or execute controls. The real approval card is
  // a separate, later Human-gated feature.
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>GhostFleet 审批能力验证</title>
  <style>
    :root { font-family: system-ui, -apple-system, sans-serif; }
    body { margin: 0; padding: 16px; color: CanvasText; background: Canvas; }
    .panel { max-width: 560px; border: 1px solid GrayText; border-radius: 12px; padding: 16px; }
    h1 { font-size: 17px; margin: 0 0 9px; }
    p { font-size: 13px; margin: 8px 0; line-height: 1.5; }
    button { font: inherit; background: ButtonFace; color: ButtonText; border: 1px solid GrayText; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .small { font-size: 12px; opacity: .8; }
    #result { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin-top: 12px; }
    @media (max-width: 400px) { body { padding: 8px; } .panel { padding: 12px; } }
  </style>
</head>
<body>
  <section class="panel" aria-labelledby="title">
    <h1 id="title">GhostFleet · ChatGPT Web 审批能力验证</h1>
    <p>此卡片只验证 MCP App 按钮、宿主调用桥和授权隔离。不会批准申请、签发租约或执行宿主命令。</p>
    <p class="small">Phase 0 · no approval / no host effect</p>
    <button id="probe" type="button">点击验证调用桥</button>
    <div id="result" role="status" aria-live="polite">等待人工点击。</div>
  </section>
  <script>
    "use strict";
    (function () {
      var button = document.getElementById("probe");
      var output = document.getElementById("result");
      button.addEventListener("click", async function () {
        if (button.disabled) return;
        button.disabled = true;
        output.textContent = "正在向宿主请求只读能力回执…";
        try {
          // ChatGPT's documented compatibility alias maps to MCP Apps tools/call.
          // Future portable UI uses the upstream ext-apps App bridge directly.
          if (!window.openai || typeof window.openai.callTool !== "function") {
            throw new Error("HOST_CALL_TOOL_UNAVAILABLE");
          }
          var result = await window.openai.callTool(
            "fleet_admin_ui_probe",
            { probe_id: "ghostfleet-p0-v1" }
          );
          if (!result || result.isError === true) {
            throw new Error("HOST_PROBE_FAILED");
          }
          var payload = result.structuredContent;
          if (!payload || payload.probe !== "ok" || payload.approval_effect !== false) {
            throw new Error("HOST_PROBE_INVALID_RESPONSE");
          }
          output.textContent = "验证通过：Host Bridge 调用返回只读回执；未发生审批。";
        } catch (error) {
          output.textContent = "验证未通过：" + (
            error && error.message && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message : "HOST_PROBE_UNKNOWN"
          );
        } finally {
          button.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}
