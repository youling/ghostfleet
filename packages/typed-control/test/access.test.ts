import {describe,it,expect} from "vitest";
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from "jose";
import {verifyAccessOwner,accessConfigured} from "../src/authorization/access.js";

const env={ACCESS_TEAM_DOMAIN:"https://synthetic.cloudflareaccess.com",ACCESS_POLICY_AUD:"synthetic-audience-value",ACCESS_OWNER_EMAIL:"owner@example.invalid"};
describe("optional Access validates issuer/audience/owner rather than header presence",()=>{
  it("fails closed for absent deployment setup or assertion",async()=>{
    const request=new Request("https://controller.example.invalid/authorize");expect(accessConfigured({})).toBe(false);expect((await verifyAccessOwner(request,{} ) as Response).status).toBe(503);expect((await verifyAccessOwner(request,env) as Response).status).toBe(401);
  });
  it("accepts independently verified signed identity and refuses wrong audience/owner/expiry",async()=>{
    // Ephemeral test-only signing key is never exported or printed as secret material.
    const pair=await generateKeyPair("RS256");const publicKey=await exportJWK(pair.publicKey);const local=createLocalJWKSet({keys:[{...publicKey,kid:"synthetic-key",alg:"RS256"}]});
    for(const variant of ["valid","audience","owner","expired"]){
      const token=await new SignJWT({email:variant==="owner"?"different@example.invalid":env.ACCESS_OWNER_EMAIL,type:"app"}).setProtectedHeader({alg:"RS256",kid:"synthetic-key"}).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(variant==="audience"?"different-audience":env.ACCESS_POLICY_AUD).setSubject("synthetic-owner").setIssuedAt().setExpirationTime(variant==="expired"?Math.floor(Date.now()/1000)-60:Math.floor(Date.now()/1000)+60).sign(pair.privateKey);
      const result=await verifyAccessOwner(new Request("https://controller.example.invalid/authorize",{headers:{"cf-access-jwt-assertion":token}}),env,local);
      if(variant==="valid")expect(result).toEqual({subject:"synthetic-owner",email:env.ACCESS_OWNER_EMAIL});else expect(result).toBeInstanceOf(Response);
    }
  });
});
