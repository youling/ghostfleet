/**
 * validate.js — non-throwing validator. Returns {ok:true,value} or
 * {ok:false,errors:[{code,path,message}]}. Never throws.
 */

import { templateDigest } from "./digest.js";
import {
  PLATFORM_VALUES,
  ROLE_VALUES,
  HUMANGATE_VALUES,
  RECOVERY_VALUES,
  ACCEPTANCE_VALUES,
  FIELD_SPEC,
  isValidSemverStruct,
  isValidGeneration,
  isKnownPlatform,
  isValidRoles,
  isKnownEnumValue,
  isValidExtendsRef,
  isUnknownOption,
  looksLikePlaintextSecret,
  isSecretReference,
} from "./schema.js";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/** Recursively collect every string value in a JSON-ish structure. */
function* walkStrings(v, path = "") {
  if (typeof v === "string") {
    yield [path, v];
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* walkStrings(v[i], `${path}[${i}]`);
  } else if (isPlainObject(v)) {
    for (const k of Object.keys(v)) yield* walkStrings(v[k], path ? `${path}.${k}` : k);
  }
}

/**
 * validateTemplate(input, options?)
 * options.knownProviderOptions?: string[] — when provided, provider_options
 * keys must all be in this list (UNKNOWN_OPTION otherwise).
 * options.knownTransports?: string[] — optional allowlist for transport.
 */
export function validateTemplate(input, options = {}) {
  const errors = [];
  const push = (code, path, message) => errors.push({ code, path, message });

  if (!isPlainObject(input)) {
    push("NOT_OBJECT", "$", "template must be a plain object");
    return { ok: false, errors };
  }

  // required fields + unknown-key defense
  const known = new Set(FIELD_SPEC.map((f) => f.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) push("UNKNOWN_KEY", key, `unknown key: ${key}`);
    if (key === "digest" || key === "attempt_binding") {
      push("UNKNOWN_KEY", key, `internal key not allowed: ${key}`);
    }
  }
  for (const f of FIELD_SPEC) {
    if (f.required && !(f.name in input)) {
      push("MISSING_FIELD", f.name, `required field missing: ${f.name}`);
    }
  }

  if ("template_id" in input && !isNonEmptyString(input.template_id)) {
    push("INVALID_TEMPLATE_ID", "template_id", "template_id must be a non-empty string");
  }
  if ("version" in input && !isValidSemverStruct(input.version)) {
    push("INVALID_VERSION", "version", "version must be semver struct {major,minor,patch[,prerelease][,build]}");
  }
  if ("generation" in input && !isValidGeneration(input.generation)) {
    push("INVALID_GENERATION", "generation", "generation must be a positive integer (>=1)");
  }
  if ("platform" in input && !isKnownPlatform(input.platform)) {
    push("INVALID_PLATFORM", "platform", `platform must be one of ${PLATFORM_VALUES.join("|")}`);
  }
  if ("roles" in input && !isValidRoles(input.roles)) {
    push("INVALID_ROLES", "roles", `roles must be a non-empty subset of ${ROLE_VALUES.join("|")}`);
  }
  if ("capabilities" in input) {
    if (!Array.isArray(input.capabilities) || input.capabilities.some((c) => typeof c !== "string")) {
      push("INVALID_CAPABILITIES", "capabilities", "capabilities must be an array of strings");
    }
  }
  if ("transport" in input) {
    if (!isNonEmptyString(input.transport)) {
      push("INVALID_TRANSPORT", "transport", "transport must be a non-empty string");
    } else if (Array.isArray(options.knownTransports) && !options.knownTransports.includes(input.transport)) {
      push("UNKNOWN_TRANSPORT", "transport", `unknown transport: ${input.transport}`);
    }
  }
  if ("provider_options" in input) {
    if (!isPlainObject(input.provider_options)) {
      push("INVALID_PROVIDER_OPTIONS", "provider_options", "provider_options must be an object");
    } else {
      for (const k of Object.keys(input.provider_options)) {
        if (Array.isArray(options.knownProviderOptions) && isUnknownOption(options.knownProviderOptions, k)) {
          push("UNKNOWN_OPTION", `provider_options.${k}`, `unknown provider option key: ${k}`);
        }
        const v = input.provider_options[k];
        if (typeof v === "string") {
          if (looksLikePlaintextSecret(v)) {
            push("PLAINTEXT_SECRET", `provider_options.${k}`, "plaintext secret-shaped value");
          }
          if (/secret|password|passwd|token|api[_-]?key|credential|bearer|private/i.test(k) && !isSecretReference(v)) {
            push("SECRET_REF_REQUIRED", `provider_options.${k}`, "secret-typed option must be a secret:// / ref: / env: reference");
          }
        }
      }
    }
  }
  if ("overridable_options" in input) {
    if (!Array.isArray(input.overridable_options) || input.overridable_options.some((k) => typeof k !== "string")) {
      push("INVALID_OVERRIDABLE_OPTIONS", "overridable_options", "overridable_options must be an array of strings");
    }
  }
  if ("privilege_broker_required" in input && typeof input.privilege_broker_required !== "boolean") {
    push("INVALID_PRIVILEGE_BROKER_REQUIRED", "privilege_broker_required", "must be boolean");
  }
  if ("helper" in input && input.helper !== null && !isPlainObject(input.helper)) {
    push("INVALID_HELPER", "helper", "helper must be an object or null");
  }
  if ("humangate" in input && !isKnownEnumValue(HUMANGATE_VALUES, input.humangate)) {
    push("INVALID_HUMANGATE", "humangate", `humangate must be one of ${HUMANGATE_VALUES.join("|")}`);
  }
  if ("recovery" in input) {
    const ok =
      isKnownEnumValue(RECOVERY_VALUES, input.recovery) ||
      isPlainObject(input.recovery);
    if (!ok) push("INVALID_RECOVERY", "recovery", `recovery must be one of ${RECOVERY_VALUES.join("|")} or an object`);
  }
  if ("acceptance" in input && !isKnownEnumValue(ACCEPTANCE_VALUES, input.acceptance)) {
    push("INVALID_ACCEPTANCE", "acceptance", `acceptance must be one of ${ACCEPTANCE_VALUES.join("|")}`);
  }
  if ("bootstrap" in input && !isPlainObject(input.bootstrap)) {
    push("INVALID_BOOTSTRAP", "bootstrap", "bootstrap must be an object");
  }
  if ("extends" in input) {
    if (input.extends !== null && (typeof input.extends !== "string" || input.extends.includes(",") || input.extends.includes(";"))) {
      push("MULTI_PARENT_EXTENDS", "extends", "extends must be null or a single parent ref");
    } else if (!isValidExtendsRef(input.extends)) {
      push("INVALID_EXTENDS", "extends", "extends must be <template_id>@<generation> or <template_id>#sha256:<hex>");
    }
  }

  // plaintext secret scan across all string fields
  for (const [path, s] of walkStrings(input)) {
    if (looksLikePlaintextSecret(s)) {
      push("PLAINTEXT_SECRET", path, "plaintext secret-shaped value is not allowed");
    }
  }

  // immutable binding check: an attempt/approval recorded against a stale
  // template identity, generation or digest must NOT be silently inherited.
  if (isPlainObject(options.attemptBinding)) {
    const ab = options.attemptBinding;
    const stale = [];
    if (typeof ab.template_id === "string" && "template_id" in input && ab.template_id !== input.template_id) {
      stale.push(`template_id ${ab.template_id} != ${input.template_id}`);
    }
    if (typeof ab.generation === "number" && typeof input.generation === "number" && ab.generation !== input.generation) {
      stale.push(`generation ${ab.generation} != ${input.generation}`);
    }
    if (typeof ab.digest === "string" && isPlainObject(input) && typeof input.template_id === "string") {
      try {
        const currentDigest = templateDigest(input);
        if (ab.digest !== currentDigest) stale.push(`digest ${ab.digest} != ${currentDigest}`);
      } catch {
        stale.push("digest not computable");
      }
    }
    if (stale.length > 0) {
      push("ATTEMPT_BINDING_STALE", "attempt_binding", `attempt binding mismatch (STALE): ${stale.join("; ")}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input };
}
