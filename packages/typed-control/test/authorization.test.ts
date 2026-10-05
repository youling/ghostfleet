import {describe,it,expect} from "vitest";
import {validateClientProfile,validateRegistration,validateAuthorizationRequest,verifyPkce,bearerTokenMatches,guardOAuthRequest,ownerConsentForm,verifyOwnerConsentLink} from "../src/authorization/index.js";
import type {OAuthClientProfile} from "../src/authorization/clientProfile.js";

const verifier="a".repeat(43);
async function challenge(){const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)));return btoa(String.fromCharCode(...hash)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function profile(client:string):OAuthClientProfile{return {profile_id:"synthetic-"+client,client_id:client,client_name:"Synthetic "+client,redirect_uris:["https://"+client+".example.invalid/oauth/callback"],scopes:["fleet.read"]};}
function params(p:OAuthClientProfile,codeChallenge:string){return new URLSearchParams({client_id:p.client_id,redirect_uri:p.redirect_uris[0]!,response_type:"code",scope:"fleet.read",state:"synthetic-state-value",code_challenge:codeChallenge,code_challenge_method:"S256"});}
function registration(p:OAuthClientProfile){return validateRegistration({client_name:p.client_name,redirect_uris:p.redirect_uris,scope:"fleet.read",grant_types:["authorization_code"],response_types:["code"],token_endpoint_auth_method:"none"},p);}
describe("optional neutral authorization helpers",()=>{
  it.each(["alpha","beta"])("validates unrelated configured client %s without vendor callback or SDK",async(client)=>{
    const p=profile(client);const query=params(p,await challenge());expect(validateAuthorizationRequest(query,p,registration(p)).profile_id).toBe(p.profile_id);
    expect(validateRegistration({client_name:p.client_name,redirect_uris:p.redirect_uris,scope:"fleet.read",grant_types:["authorization_code"],response_types:["code"],token_endpoint_auth_method:"none"},p).scopes).toEqual(["fleet.read"]);
    expect(await verifyPkce(verifier,query.get("code_challenge")!)).toBe(true);
  });
  it("rejects wildcard, changed client, duplicate redirect, wider scope and weak PKCE",async()=>{
    const p=profile("alpha");expect(()=>validateClientProfile({...p,redirect_uris:["https://*.example.invalid/callback"]})).toThrow("OAUTH_PROFILE_INVALID");
    const stored=registration(p);
    const query=params(p,await challenge());query.set("redirect_uri","https://beta.example.invalid/oauth/callback");expect(()=>validateAuthorizationRequest(query,p,stored)).toThrow("OAUTH_CLIENT_BINDING_MISMATCH");
    const duplicate=params(p,await challenge());duplicate.append("redirect_uri",p.redirect_uris[0]!);expect(()=>validateAuthorizationRequest(duplicate,p,stored)).toThrow("OAUTH_REQUEST_INVALID");
    const wider=params(p,await challenge());wider.set("scope","fleet.exec");expect(()=>validateAuthorizationRequest(wider,p,stored)).toThrow("OAUTH_SCOPE_NOT_ALLOWED");
    const weak=params(p,await challenge());weak.set("code_challenge_method","plain");expect(()=>validateAuthorizationRequest(weak,p,stored)).toThrow("OAUTH_PKCE_REQUIRED");expect(await verifyPkce("b".repeat(43),await challenge())).toBe(false);
  });
  it("requires authenticated ingress limits before reading OAuth bodies",async()=>{
    const request=new Request("https://controller.example.invalid/oauth/register",{method:"POST",body:"{}"});const result=await guardOAuthRequest(request,{});expect(result).toBeInstanceOf(Response);expect((result as Response).status).toBe(503);
    const denied=await guardOAuthRequest(new Request(request.url,{method:"POST",body:"{}"}),{OAUTH_EDGE_BUDGET:{limit:async()=>({success:false})},OAUTH_SOURCE_LIMIT:{limit:async()=>({success:true})}});expect((denied as Response).status).toBe(429);
  });
  it("compares bearer material without reflecting it",async()=>{
    const inert="synthetic-inert-label-"+"x".repeat(32);expect(await bearerTokenMatches(inert,inert)).toBe(true);expect(await bearerTokenMatches(inert,"synthetic-inert-label-"+"y".repeat(32))).toBe(false);expect(await bearerTokenMatches("short","short")).toBe(false);
  });
  it("binds signed owner approval to client query, subject and origin",async()=>{
    const origin="https://controller.example.invalid";const owner={subject:"synthetic-owner",email:"owner@example.invalid"};const secret="synthetic-inert-label-"+"x".repeat(32);
    const form=await ownerConsentForm(new Request(origin+"/authorize?client_id=alpha&scope=fleet.read"),secret,"Synthetic Alpha",owner,origin);
    const html=await form.text();const link=html.match(/href="([^"]*approval=1[^"]*)"/)![1]!.replaceAll("&amp;","&");
    const proofRequest=new Request(origin+link);expect(await verifyOwnerConsentLink(proofRequest,secret,origin,owner)).toContain("client_id=alpha");
    const different=await verifyOwnerConsentLink(proofRequest,secret,origin,{...owner,subject:"different-owner"});expect(different).toBeInstanceOf(Response);expect((different as Response).status).toBe(403);
    expect(await verifyOwnerConsentLink(proofRequest,secret,"https://different.example.invalid",owner)).toBeInstanceOf(Response);
  });
});
