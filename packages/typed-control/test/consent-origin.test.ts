import {Buffer} from "buffer";
import {describe,it,expect,vi} from "vitest";
import {ownerConsentForm,verifyOwnerConsentLink,verifyOwnerConsent} from "../src/authorization/ownerConsent.js";

const first="https://alpha.example.invalid",second="https://beta.example.invalid";
const owner={subject:"synthetic-owner",email:"owner@example.invalid"};
const secret="synthetic-inert-label-"+"a".repeat(32);
async function issue(){const response=await ownerConsentForm(new Request(first+"/authorize?client_id=synthetic-client&scope=fleet.read"),secret,"Synthetic client",owner,first);const html=await response.text();return {query:html.match(/href="([^"]*approval=1[^"]*)"/)![1]!.replaceAll("&amp;","&"),cookie:response.headers.get("set-cookie")!.split(";")[0]!};}
function post(origin:string,proof:string,cookie:string){return new Request(origin+"/authorize",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",origin,"sec-fetch-site":"same-origin",cookie},body:new URLSearchParams({proof,consent:"approve"})});}
describe("signed consent v2 trusted origin binding",()=>{
  it("rejects same-secret/same-owner cross-origin GET and POST replay",async()=>{
    const issued=await issue();const proof=new URL(first+issued.query).searchParams.get("proof")!;
    expect(await verifyOwnerConsentLink(new Request(first+issued.query),secret,first,owner)).toContain("client_id=synthetic-client");
    expect(await verifyOwnerConsent(post(first,proof,issued.cookie),secret,first,owner)).toContain("client_id=synthetic-client");
    const get=await verifyOwnerConsentLink(new Request(second+issued.query),secret,second,owner);expect(get).toBeInstanceOf(Response);expect(await (get as Response).text()).toBe("CONSENT_PROOF_ORIGIN_MISMATCH");
    const submitted=await verifyOwnerConsent(post(second,proof,issued.cookie),secret,second,owner);expect(submitted).toBeInstanceOf(Response);expect(await (submitted as Response).text()).toBe("CONSENT_PROOF_ORIGIN_MISMATCH");
  });
  it("requires exact trusted HTTPS issuer origin and rejects tamper, wrong owner and expiration",async()=>{
    expect((await ownerConsentForm(new Request(first+"/authorize"),secret,"Synthetic",owner,second)).status).toBe(403);
    const issued=await issue();const parsed=new URL(first+issued.query);const proof=parsed.searchParams.get("proof")!;
    const [payload,signature]=proof.split(".");const changedBytes=Buffer.from(signature!,"base64url");changedBytes[0]=changedBytes[0]!^1;
    const tampered=payload+"."+changedBytes.toString("base64url");parsed.searchParams.set("proof",tampered);expect(await verifyOwnerConsentLink(new Request(parsed),secret,first,owner)).toBeInstanceOf(Response);
    expect(await verifyOwnerConsentLink(new Request(first+issued.query),secret,first,{...owner,subject:"other-owner"})).toBeInstanceOf(Response);
    const now=Date.now();const spy=vi.spyOn(Date,"now").mockReturnValue(now+301000);try {expect(await verifyOwnerConsentLink(new Request(first+issued.query),secret,first,owner)).toBeInstanceOf(Response);} finally {spy.mockRestore();}
  });
  it("does not silently accept old originless or changed-nonce signed payloads",async()=>{
    const issued=await issue();const parsed=new URL(first+issued.query);const original=parsed.searchParams.get("proof")!.split(".");
    const payload=JSON.parse(Buffer.from(original[0]!,"base64url").toString("utf8"));delete payload.origin;
    const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const signature=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("fleet-consent-v1:"+encoded));parsed.searchParams.set("proof",encoded+"."+Buffer.from(signature).toString("base64url"));
    expect(await verifyOwnerConsentLink(new Request(parsed),secret,first,owner)).toBeInstanceOf(Response);
    const proof=new URL(first+issued.query).searchParams.get("proof")!;expect(await verifyOwnerConsent(post(first,proof,"__Host-fleet-consent=different-synthetic-nonce"),secret,first,owner)).toBeInstanceOf(Response);
  });
});
