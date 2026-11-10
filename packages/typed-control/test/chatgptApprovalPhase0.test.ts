import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  APPROVAL_PHASE0_URI,
  APPROVAL_PHASE0_MIME,
  APPROVAL_PHASE0_SCOPE,
  APPROVAL_PHASE0_TOOL,
  chatgptApprovalPhase0ProbeHtml,
} from "../src/compat/chatgptApprovalPhase0.js";

function bootProbe(hostTool?: (name: string, args: unknown) => Promise<unknown>) {
  const html = chatgptApprovalPhase0ProbeHtml();
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("MISSING_PROBE_SCRIPT");
  let click: (() => Promise<void>) | undefined;
  const button = {
    disabled: false,
    addEventListener(type: string, fn: () => Promise<void>) {
      if (type !== "click") throw new Error("UNEXPECTED_EVENT");
      click = fn;
    },
  };
  const result = { textContent: "" };
  const document = {
    getElementById(id: string) {
      if (id === "probe") return button;
      if (id === "result") return result;
      throw new Error("UNKNOWN_ELEMENT");
    },
  };
  const window = hostTool ? { openai: { callTool: hostTool } } : {};
  runInNewContext(match[1], { document, window, Error });
  if (!click) throw new Error("CLICK_HANDLER_MISSING");
  return { html, click, button, result };
}

describe("optional ChatGPT approval Phase 0 probe", () => {
  it("publishes an opt-in, versioned MCP App resource without privileged effects", () => {
    expect(APPROVAL_PHASE0_URI).toBe("ui://ghostfleet/admin-approval-phase0/v1.html");
    expect(APPROVAL_PHASE0_MIME).toBe("text/html;profile=mcp-app");
    expect(APPROVAL_PHASE0_SCOPE).toBe("fleet.privileged.approve");
    expect(APPROVAL_PHASE0_TOOL).toBe("fleet_admin_ui_probe");
    const html = chatgptApprovalPhase0ProbeHtml();
    expect(html).toContain("lang=\"zh-Hans\"");
    expect(html).toContain("role=\"status\"");
    expect(html).not.toMatch(/localStorage|widgetState|document\.cookie|Authorization:|fetch\(/i);
    expect(html).not.toMatch(/fleet_admin_human_decide|fleet_admin_command_execute|admin\/approve/i);
  });

  it("never calls a tool on rendering, and invokes one inert app-only probe only after a real click", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const view = bootProbe(async (name, args) => {
      calls.push({ name, args });
      return { isError: false, structuredContent: { probe: "ok", approval_effect: false } };
    });
    expect(calls).toEqual([]);
    expect(view.result.textContent).toBe("");
    await view.click();
    expect(calls).toEqual([{ name: "fleet_admin_ui_probe", args: { probe_id: "ghostfleet-p0-v1" } }]);
    expect(view.result.textContent).toContain("验证通过");
    expect(view.button.disabled).toBe(false);
  });

  it("fails closed without a Host bridge or on malformed tool response", async () => {
    const noHost = bootProbe();
    await noHost.click();
    expect(noHost.result.textContent).toContain("HOST_CALL_TOOL_UNAVAILABLE");

    const invalidHost = bootProbe(async () => ({ content: [{ type: "text", text: "success" }] }));
    await invalidHost.click();
    expect(invalidHost.result.textContent).toContain("HOST_PROBE_INVALID_RESPONSE");
  });
});
