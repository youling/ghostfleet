import {CONTROL_SCOPES} from "../controlPolicy.js";

/** Trusted deployment profile. Client requests cannot create or widen it. */
export interface OAuthClientProfile {
  profile_id:string;
  client_id:string;
  client_name:string;
  redirect_uris:readonly string[];
  scopes:readonly string[];
}
const allowedScopes=new Set<string>([...CONTROL_SCOPES,"offline_access"]);
export interface RegisteredClientBinding {
  schema:"ghostfleet-oauth-client-binding/v1";
  profile_id:string;
  client_id:string;
  client_name:string;
  redirect_uris:string[];
  scopes:string[];
  profile_snapshot:string;
}
function profileSnapshot(profile:OAuthClientProfile):string {
  return JSON.stringify({profile_id:profile.profile_id,client_id:profile.client_id,client_name:profile.client_name,redirect_uris:[...profile.redirect_uris],scopes:[...profile.scopes]});
}
function exactRedirect(value:string):boolean {
  try {
    const url=new URL(value);
    return value.length<=2000 && !value.includes("*") && !url.username && !url.password && !url.hash && url.protocol==="https:" && url.href===value;
  } catch{return false;}
}
export function validateClientProfile(profile:OAuthClientProfile):OAuthClientProfile {
  if(!profile || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(profile.profile_id) || !profile.client_id || profile.client_id.length>256 || !profile.client_name || profile.client_name.length>100 ||
     !Array.isArray(profile.redirect_uris) || profile.redirect_uris.length<1 || profile.redirect_uris.length>8 || new Set(profile.redirect_uris).size!==profile.redirect_uris.length || !profile.redirect_uris.every(exactRedirect) ||
     !Array.isArray(profile.scopes) || profile.scopes.length<1 || new Set(profile.scopes).size!==profile.scopes.length || !profile.scopes.every(scope=>allowedScopes.has(scope))) throw new Error("OAUTH_PROFILE_INVALID");
  return { ...profile, redirect_uris:Object.freeze([...profile.redirect_uris]),scopes:Object.freeze([...profile.scopes]) };
}
export function validateRegistration(metadata:unknown, configuredProfile:OAuthClientProfile) {
  const profile=validateClientProfile(configuredProfile);
  if(!metadata || typeof metadata!=="object" || Array.isArray(metadata)) throw new Error("OAUTH_CLIENT_METADATA_INVALID");
  const value=metadata as Record<string,unknown>;
  const permitted=new Set(["client_name","redirect_uris","scope","grant_types","response_types","token_endpoint_auth_method"]);
  if(Object.keys(value).some(key=>!permitted.has(key)) || value.client_name!==profile.client_name || value.token_endpoint_auth_method!=="none" ||
     JSON.stringify(value.redirect_uris)!==JSON.stringify(profile.redirect_uris) || JSON.stringify(value.response_types)!==JSON.stringify(["code"]) ||
     !Array.isArray(value.grant_types) || value.grant_types.length<1 || new Set(value.grant_types).size!==value.grant_types.length || !value.grant_types.includes("authorization_code") ||
     value.grant_types.some(grant=>grant!=="authorization_code" && !(grant==="refresh_token" && profile.scopes.includes("offline_access")))) throw new Error("OAUTH_CLIENT_METADATA_INVALID");
  const scopes=typeof value.scope==="string" ? value.scope.split(" ").filter(Boolean) : [];
  if(scopes.length<1 || new Set(scopes).size!==scopes.length || scopes.some(scope=>!profile.scopes.includes(scope))) throw new Error("OAUTH_SCOPE_NOT_ALLOWED");
  return {schema:"ghostfleet-oauth-client-binding/v1" as const,profile_id:profile.profile_id,client_id:profile.client_id,client_name:profile.client_name,redirect_uris:[...profile.redirect_uris],scopes,profile_snapshot:profileSnapshot(profile)};
}
/** Trusted issuer retrieves stored binding; request data never supplies it. */
export function revalidateRegisteredClient(stored:RegisteredClientBinding,configuredProfile:OAuthClientProfile):RegisteredClientBinding {
  const profile=validateClientProfile(configuredProfile);
  if(!stored || stored.schema!=="ghostfleet-oauth-client-binding/v1" || stored.profile_id!==profile.profile_id || stored.client_id!==profile.client_id || stored.client_name!==profile.client_name ||
     JSON.stringify(stored.redirect_uris)!==JSON.stringify(profile.redirect_uris) || stored.profile_snapshot!==profileSnapshot(profile) || !Array.isArray(stored.scopes) || !stored.scopes.length || new Set(stored.scopes).size!==stored.scopes.length || stored.scopes.some(scope=>!profile.scopes.includes(scope))) throw new Error("OAUTH_STORED_CLIENT_STALE");
  return { ...stored,redirect_uris:[...stored.redirect_uris],scopes:[...stored.scopes] };
}
export function validateAuthorizationRequest(params:URLSearchParams, configuredProfile:OAuthClientProfile,stored:RegisteredClientBinding) {
  const profile=validateClientProfile(configuredProfile);
  const client=revalidateRegisteredClient(stored,profile);
  for(const key of ["client_id","redirect_uri","response_type","scope","state","code_challenge","code_challenge_method"]) if(params.getAll(key).length!==1) throw new Error("OAUTH_REQUEST_INVALID");
  if(params.get("client_id")!==profile.client_id || params.get("response_type")!=="code" || !profile.redirect_uris.includes(params.get("redirect_uri")!)) throw new Error("OAUTH_CLIENT_BINDING_MISMATCH");
  if(params.get("code_challenge_method")!=="S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge")!) || !/^[A-Za-z0-9._~-]{16,256}$/.test(params.get("state")!)) throw new Error("OAUTH_PKCE_REQUIRED");
  const scopes=params.get("scope")!.split(" ").filter(Boolean);
  if(scopes.length<1 || new Set(scopes).size!==scopes.length || scopes.some(scope=>!client.scopes.includes(scope))) throw new Error("OAUTH_SCOPE_NOT_ALLOWED");
  return {profile_id:profile.profile_id,client_id:profile.client_id,redirect_uri:params.get("redirect_uri")!,scopes,state:params.get("state")!,code_challenge:params.get("code_challenge")!};
}
export interface TokenScopeBinding {protocol:"ghostfleet-oauth-grant/v1";client_id:string;profile_id:string;scopes:readonly string[]}
/** Revalidate already-authenticated token/refresh grant against trusted current registration. */
export function revalidateTokenScope(grant:TokenScopeBinding,stored:RegisteredClientBinding,configuredProfile:OAuthClientProfile):TokenScopeBinding {
  const client=revalidateRegisteredClient(stored,configuredProfile);
  if(!grant || grant.protocol!=="ghostfleet-oauth-grant/v1" || grant.client_id!==client.client_id || grant.profile_id!==client.profile_id ||
     !Array.isArray(grant.scopes) || !grant.scopes.length || new Set(grant.scopes).size!==grant.scopes.length || grant.scopes.some(scope=>!client.scopes.includes(scope))) throw new Error("OAUTH_TOKEN_SCOPE_STALE");
  return {...grant,scopes:Object.freeze([...grant.scopes])};
}
/** Called against persisted authorization binding, never a caller-selected challenge. */
export async function verifyPkce(verifier:string, storedChallenge:string):Promise<boolean> {
  if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(storedChallenge)) return false;
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)));
  const challenge=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  let difference=0;for(let index=0;index<challenge.length;index++)difference|=challenge.charCodeAt(index)^storedChallenge.charCodeAt(index);
  return difference===0;
}
