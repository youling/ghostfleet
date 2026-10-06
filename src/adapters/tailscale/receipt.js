const SECRET_KEY=/(auth.?key|api.?token|private.?key|password|credential|secret)/i;
const ALLOWED=new Set(["schema","operation_ref","template_digest","node_ref","desired_enabled","desired_ssh","result","reason_codes","observed_state_ref","recorded_at"]);

export function sanitizeTailscaleReceipt(input={}) {
  for(const key of Object.keys(input)) {
    if(SECRET_KEY.test(key)) throw new Error("SECRET_FIELD_FORBIDDEN");
  }
  const out={};
  for(const key of ALLOWED) if(input[key]!==undefined) out[key]=input[key];
  out.schema="ghostfleet-tailscale-receipt/v1";
  out.reason_codes=Array.isArray(out.reason_codes)?out.reason_codes.map(String):[];
  const text=JSON.stringify(out);
  if(/tskey-|BEGIN [A-Z ]*PRIVATE KEY/i.test(text)) throw new Error("SECRET_MATERIAL_FORBIDDEN");
  return Object.freeze(out);
}
