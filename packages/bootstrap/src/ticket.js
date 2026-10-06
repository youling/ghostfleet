import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const hash=(value)=>createHash("sha256").update(String(value)).digest("hex");
const equalHash=(a,b)=>{
  const left=Buffer.from(String(a)), right=Buffer.from(String(b));
  return left.length===right.length && timingSafeEqual(left,right);
};
const publicRecord=(record)=>({
  ticket_id:record.ticket_id,
  attempt_id:record.attempt_id,
  template_generation:record.template_generation,
  template_digest:record.template_digest,
  state:record.state,
  issued_at:record.issued_at,
  expires_at:record.expires_at,
  claimed_at:record.claimed_at ?? null,
  preflight_digest:record.preflight_digest ?? null,
  completion:record.completion ?? null,
});

export function createEnrollmentTicketStore({
  now=()=>Date.now(),
  secretFactory=()=>randomBytes(32).toString("base64url"),
  codeFactory=()=>randomBytes(4).toString("hex").toUpperCase(),
}={}) {
  const records=new Map();
  return Object.freeze({
    issue({ticket_id,attempt_id,template_generation,template_digest,ttl_seconds=600}) {
      if(!ticket_id||!attempt_id||!template_digest) throw new Error("TICKET_BINDING_REQUIRED");
      if(records.has(ticket_id)) throw new Error("TICKET_ALREADY_EXISTS");
      const claim_secret=secretFactory(), short_code=codeFactory();
      if(String(claim_secret)===String(short_code)) throw new Error("TICKET_FACTORS_MUST_DIFFER");
      const issued=now();
      const record={
        ticket_id,attempt_id,template_generation,template_digest,
        state:"ISSUED",issued_at:new Date(issued).toISOString(),
        expires_at:new Date(issued+Number(ttl_seconds)*1000).toISOString(),
        secret_hash:hash(claim_secret),code_hash:hash(short_code),
      };
      records.set(ticket_id,record);
      return {record:publicRecord(record),delivery:Object.freeze({ticket_id,claim_secret,short_code})};
    },
    claim({ticket_id,claim_secret,short_code,attempt_id,template_digest,preflight_digest}) {
      const record=records.get(ticket_id);
      if(!record) return {ok:false,code:"TICKET_NOT_FOUND"};
      if(record.state!=="ISSUED") return {ok:false,code:"TICKET_NOT_CLAIMABLE",state:record.state};
      if(now()>=Date.parse(record.expires_at)) {
        record.state="EXPIRED";
        return {ok:false,code:"TICKET_EXPIRED"};
      }
      if(record.attempt_id!==attempt_id) return {ok:false,code:"TICKET_ATTEMPT_MISMATCH"};
      if(record.template_digest!==template_digest) return {ok:false,code:"TICKET_TEMPLATE_STALE"};
      if(!preflight_digest) return {ok:false,code:"PREFLIGHT_DIGEST_REQUIRED"};
      if(!equalHash(record.secret_hash,hash(claim_secret))) return {ok:false,code:"TICKET_SECRET_INVALID"};
      if(!equalHash(record.code_hash,hash(short_code))) return {ok:false,code:"TICKET_SHORT_CODE_INVALID"};
      record.state="CLAIMED";
      record.claimed_at=new Date(now()).toISOString();
      record.preflight_digest=preflight_digest;
      record.secret_hash=null;
      record.code_hash=null;
      return {ok:true,record:publicRecord(record)};
    },
    complete(ticket_id,{outcome="COMPLETED"}={}) {
      const record=records.get(ticket_id);
      if(!record) return {ok:false,code:"TICKET_NOT_FOUND"};
      if(record.state!=="CLAIMED" && record.state!=="RECONCILE_REQUIRED") return {ok:false,code:"TICKET_NOT_COMPLETABLE",state:record.state};
      if(!["COMPLETED","RECONCILE_REQUIRED","FAILED"].includes(outcome)) throw new Error("INVALID_COMPLETION_OUTCOME");
      record.state=outcome;
      record.completion={outcome,recorded_at:new Date(now()).toISOString()};
      return {ok:true,record:publicRecord(record)};
    },
    get(ticket_id) {
      const record=records.get(ticket_id);
      return record ? publicRecord(record) : null;
    },
  });
}
