import { t } from "../shared/i18n.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char]));

export function renderProviderStatus(provider) {
  const status = provider?.status || "MISSING";
  const ready = status === "READY";
  return `
    <section class="settings-section provider-card" aria-labelledby="tailscale-provider-title">
      <div class="settings-description">
        <h2 id="tailscale-provider-title">${escapeHtml(t("provider.tailscale"))}</h2>
        <p class="secondary">${escapeHtml(t("provider.tailscale.description"))}</p>
      </div>
      <div class="settings-form">
        <p class="state ${ready ? "success" : "warning"}">${escapeHtml(t(`provider.status.${status.toLowerCase()}`))}</p>
        <dl class="detail-fields">
          <dt>${escapeHtml(t("provider.scope"))}</dt>
          <dd>${escapeHtml(provider?.required?.scope || "auth_keys")}</dd>
          <dt>${escapeHtml(t("provider.tag"))}</dt>
          <dd>${escapeHtml(provider?.required?.tag || "tag:fleet-ssh-target")}</dd>
        </dl>
        ${ready ? "" : `<button class="btn btn-primary" type="button" data-provider-setup="tailscale">${escapeHtml(t("provider.connect"))}</button>`}
      </div>
    </section>`;
}
