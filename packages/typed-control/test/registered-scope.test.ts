import {describe,it,expect} from "vitest";
import {validateRegistration,validateAuthorizationRequest,revalidateRegisteredClient,revalidateTokenScope} from "../src/authorization/clientProfile.js";
import type {OAuthClientProfile} from "../src/authorization/clientProfile.js";

const profile:OAuthClientProfile={profile_id:"synthetic-client",client_id:"synthetic-id",client_name:"Synthetic client",redirect_uris:["https://client.example.invalid/callback"],scopes:["fleet.read","fleet.exec"]};
function stored(){return validateRegistration({client_name:profile.client_name,redirect_uris:profile.redirect_uris,scope:"fleet.read",grant_types:["authorization_code"],response_types:["code"],token_endpoint_auth_method:"none"},profile);}
function request(scope:string){return new URLSearchParams({client_id:profile.client_id,redirect_uri:profile.redirect_uris[0]!,scope,response_type:"code",state:"synthetic-state-value",code_challenge:"a".repeat(43),code_challenge_method:"S256"});}
describe("registered client ceiling and current profile revalidation",()=>{
  it("never upgrades a registered read-only client to current exec scope",()=>{
    const binding=stored();expect(validateAuthorizationRequest(request("fleet.read"),profile,binding).scopes).toEqual(["fleet.read"]);
    expect(()=>validateAuthorizationRequest(request("fleet.exec"),profile,binding)).toThrow("OAUTH_SCOPE_NOT_ALLOWED");
    expect(()=>revalidateTokenScope({protocol:"ghostfleet-oauth-grant/v1",profile_id:profile.profile_id,client_id:profile.client_id,scopes:["fleet.exec"]},binding,profile)).toThrow("OAUTH_TOKEN_SCOPE_STALE");
  });
  it.each(["profile_id","client_id","client_name","redirect_uris","scopes"])("invalidates old stored client after configured %s changes",(field)=>{
    const current={...profile,[field]:field==="redirect_uris"?["https://different.example.invalid/callback"]:field==="scopes"?["fleet.read"]:"different"};
    expect(()=>revalidateRegisteredClient(stored(),current as OAuthClientProfile)).toThrow("OAUTH_STORED_CLIENT_STALE");
    expect(()=>validateAuthorizationRequest(request("fleet.read"),current as OAuthClientProfile,stored())).toThrow();
  });
  it("rejects absent storage binding and changed token client, without any grant/issuer effect",()=>{
    expect(()=>validateAuthorizationRequest(request("fleet.read"),profile,undefined as never)).toThrow("OAUTH_STORED_CLIENT_STALE");
    const grant={protocol:"ghostfleet-oauth-grant/v1" as const,profile_id:profile.profile_id,client_id:profile.client_id,scopes:["fleet.read"]};expect(revalidateTokenScope(grant,stored(),profile).scopes).toEqual(["fleet.read"]);
    expect(()=>revalidateTokenScope({...grant,client_id:"different"},stored(),profile)).toThrow("OAUTH_TOKEN_SCOPE_STALE");
  });
});
