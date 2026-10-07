import {
  PUBLIC_ENROLLMENT_TEMPLATES,
  PUBLIC_TEMPLATE_DISPLAY,
  createEnrollmentTemplateCatalog,
} from "../../control-plane/enrollment-templates.js";

const MAX_CATALOG_JSON_BYTES = 32768;
const ALLOWED_KEYS = new Set(["templates", "overlays", "display"]);

function displayEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_INVALID");
  const out = {};
  for (const [language, item] of Object.entries(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_INVALID");
    if (Object.keys(item).some((key) => !["name", "description"].includes(key))) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_INVALID");
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 120) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_INVALID");
    if (typeof item.description !== "string" || item.description.length > 500) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_INVALID");
    out[language] = Object.freeze({ name: item.name, description: item.description });
  }
  return Object.freeze(out);
}

export function createDeploymentEnrollmentTemplateCatalog(env = {}) {
  const raw = env?.GHOSTFLEET_ENROLLMENT_CATALOG_JSON;
  if (raw === undefined || raw === null || raw === "") return createEnrollmentTemplateCatalog();
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_CATALOG_JSON_BYTES) throw new Error("DEPLOYMENT_TEMPLATE_CATALOG_INVALID");

  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("DEPLOYMENT_TEMPLATE_CATALOG_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error("DEPLOYMENT_TEMPLATE_CATALOG_INVALID");
  }

  const templates = parsed.templates ?? [];
  const overlays = parsed.overlays ?? [];
  const display = parsed.display ?? {};
  if (!Array.isArray(templates) || !Array.isArray(overlays) || !display || typeof display !== "object" || Array.isArray(display)) {
    throw new Error("DEPLOYMENT_TEMPLATE_CATALOG_INVALID");
  }

  const publicIds = new Set(PUBLIC_ENROLLMENT_TEMPLATES.map((item) => item.template_id));
  for (const template of templates) {
    if (!template || typeof template !== "object" || Array.isArray(template) || typeof template.template_id !== "string") {
      throw new Error("DEPLOYMENT_TEMPLATE_CATALOG_INVALID");
    }
    if (publicIds.has(template.template_id)) throw new Error("DEPLOYMENT_TEMPLATE_ID_COLLISION");
  }

  const extensionIds = new Set(templates.map((item) => item.template_id));
  const extraDisplay = {};
  for (const [templateId, value] of Object.entries(display)) {
    if (!extensionIds.has(templateId)) throw new Error("DEPLOYMENT_TEMPLATE_DISPLAY_ORPHAN");
    extraDisplay[templateId] = displayEntry(value);
  }

  const catalog = createEnrollmentTemplateCatalog({
    templates: [...PUBLIC_ENROLLMENT_TEMPLATES, ...templates],
    overlays,
    display: { ...PUBLIC_TEMPLATE_DISPLAY, ...extraDisplay },
  });
  // Resolve every entry now so malformed/stale/secret-bearing deployment input
  // fails closed before the first operator selection.
  catalog.list();
  return catalog;
}
