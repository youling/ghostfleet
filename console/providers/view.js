import { t } from "../shared/i18n.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"\']/g, (char) => {
  if (char === "&") return "&amp;";
  if (char === "<") return "&lt;";
  if (char === ">") return "&gt;";
  if (char === '"') return "&quot;";
  return "&#39;";
});

export function renderProviderStatus(provider) {
  const status = provider?.status || "SERVICE_UNKNOWN";
  const ready = status === "READY";
  const unverified = status === "CONFIGURED_UNVERIFIED";
  const unknown = status === "SERVICE_UNKNOWN";
  const requirements = provider?.requirements || {};
  const secretState = provider?.secret_state || {};
  return `
    <section class="settings-section provider-card" aria-labelledby="tailscale-provider-title">
      <div class="settings-description">
        <h2 id="tailscale-provider-title">${escapeHtml(t("provider.tailscale"))}</h2>
        <p class="secondary">${escapeHtml(t("provider.tailscale.description"))}</p>
      </div>
      <div class="settings-form provider-panel">
        <div class="provider-heading">
          <span class="state ${ready ? "success" : "warning"}">${escapeHtml(t(`provider.status.${status.toLowerCase()}`))}</span>
          ${provider?.authority_generation ? `<span class="secondary provider-generation">${escapeHtml(t("provider.generation"))}: ${escapeHtml(provider.authority_generation)}</span>` : ""}
        </div>
        <dl class="detail-fields provider-fields">
          <dt>${escapeHtml(t("provider.scope"))}</dt>
          <dd><code>${escapeHtml(requirements.scope || "auth_keys")}</code></dd>
          <dt>${escapeHtml(t("provider.tag"))}</dt>
          <dd><code>${escapeHtml(requirements.tag || "—")}</code></dd>
          <dt>${escapeHtml(t("provider.observedScope"))}</dt>
          <dd><code>${escapeHtml(provider?.granted_scope || "—")}</code></dd>
          <dt>${escapeHtml(t("provider.clientId"))}</dt>
          <dd>${escapeHtml(t(`provider.secret.${String(secretState.client_id || "MISSING").toLowerCase()}`))}</dd>
          <dt>${escapeHtml(t("provider.clientSecret"))}</dt>
          <dd>${escapeHtml(t(`provider.secret.${String(secretState.client_secret || "MISSING").toLowerCase()}`))}</dd>
        </dl>
        <div class="provider-scope-note">
          <strong>${escapeHtml(t("provider.minimumAuthority"))}</strong>
          <p class="secondary">${escapeHtml(t("provider.minimumAuthorityHelp"))}</p>
        </div>
        ${unknown
          ? `<p class="secondary provider-unknown-note">${escapeHtml(t("provider.serviceUnknownHelp"))}</p>`
          : unverified
          ? `<p class="secondary provider-unverified-note">${escapeHtml(t("provider.unverifiedHelp"))}</p>`
          : ready
            ? `<p class="secondary provider-ready-note">${escapeHtml(t("provider.readyHelp"))}</p>`
            : status === "MISSING"
              ? `<button class="btn btn-primary" type="button" data-provider-setup="tailscale">${escapeHtml(t("provider.connect"))}</button>`
              : `<p class="secondary provider-unknown-note">${escapeHtml(t("provider.serviceUnknownHelp"))}</p>`}
      </div>
    </section>`;
}

export function renderProviders(providerSnapshot) {
  const tailscale = providerSnapshot?.providers?.tailscale || null;
  return renderProviderStatus(tailscale);
}
