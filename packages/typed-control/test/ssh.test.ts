import {Buffer} from "buffer";
import {describe,it,expect,vi,beforeEach} from "vitest";

const fixture=vi.hoisted(()=>({mode:"success",requested:0,authenticated:0,disposed:0,data:8}));
vi.mock("@microsoft/dev-tunnels-ssh-keys",()=>({importKey:async()=>({dispose(){fixture.disposed++;}})}));
vi.mock("@microsoft/dev-tunnels-ssh",async()=>{
  const actual=await vi.importActual<typeof import("@microsoft/dev-tunnels-ssh")>("@microsoft/dev-tunnels-ssh");
  class SyntheticSession {
    auth:((event:any)=>void)|undefined;
    onAuthenticating(handler:(event:any)=>void){this.auth=handler;}
    async connect(){}
    async authenticateServer(){const event:any={publicKey:{getPublicKeyBytes:async()=>Uint8Array.from([1,2,3])}};this.auth!(event);return !!await event.authenticationPromise;}
    async authenticateClient(){fixture.authenticated++;return fixture.mode!=="client-auth-fails";}
    async openChannel(){
      let data:(value:Buffer)=>void=()=>{};let closed:(event:unknown)=>void=()=>{};
      return {onDataReceived(handler:(value:Buffer)=>void){data=handler;},onExtendedDataReceived(){},onClosed(handler:(event:unknown)=>void){closed=handler;},adjustWindow(){},dispose(){},send:async()=>{},request:async()=>{
        fixture.requested++;
        if(fixture.mode==="request-lost")throw new Error("SYNTHETIC_LOST_RESPONSE");
        queueMicrotask(()=>{data(Buffer.alloc(fixture.data,65));closed(fixture.mode==="signal"?{exitSignal:"TERM"}:{exitStatus:0});});return true;
      }};
    }
    async close(){}dispose(){fixture.disposed++;}
  }
  return {...actual,SshClientSession:SyntheticSession};
});
import {executeSshCommand,sshKeyFingerprintSha256,SshExecutionError} from "../src/sshClient.js";
import {WorkersSocketStream} from "../src/workersSocketStream.js";

const inertPem="-----BEGIN PRIVATE KEY-----\nsynthetic fixture deliberately contains no cryptographic key\n-----END PRIVATE KEY-----";
async function target(){return {username:"fixture",hostKeyAlgorithm:"ssh-rsa" as const,hostKeySha256:await sshKeyFingerprintSha256({getPublicKeyBytes:async()=>Uint8Array.from([1,2,3])} as never)};}
function socket(){return {readable:new ReadableStream<Uint8Array>(),writable:new WritableStream<Uint8Array>(),closed:Promise.resolve(),close:vi.fn(async()=>{})};}
beforeEach(()=>{fixture.mode="success";fixture.requested=0;fixture.authenticated=0;fixture.disposed=0;fixture.data=8;});
describe("SSH adapter isolated synthetic handshake",()=>{
  it("pins host key before authenticating the client or dispatching",async()=>{
    const selected=await target();const s=socket();const result=await executeSshCommand(s,selected,inertPem,"/usr/bin/true",{timeoutMs:1000});expect(result.exit_code).toBe(0);expect(fixture.requested).toBe(1);expect(s.close).toHaveBeenCalled();expect(fixture.disposed).toBeGreaterThan(0);
  });
  it("rejects a mismatching host pin before client authentication and dispatch",async()=>{
    const selected={...await target(),hostKeySha256:"SHA256:AAAA"};const s=socket();await expect(executeSshCommand(s,selected,inertPem,"/usr/bin/true",{timeoutMs:1000})).rejects.toMatchObject({code:"SSH_HOST_KEY_MISMATCH",dispatch_state:"NOT_DISPATCHED"});expect(fixture.authenticated).toBe(0);expect(fixture.requested).toBe(0);expect(s.close).toHaveBeenCalled();
  });
  it.each(["request-lost","signal"])("preserves uncertainty after dispatch: %s",async(mode)=>{
    fixture.mode=mode;await expect(executeSshCommand(socket(),await target(),inertPem,"/usr/bin/true",{timeoutMs:1000})).rejects.toMatchObject({dispatch_state:"MAY_HAVE_EXECUTED"});expect(fixture.requested).toBe(1);
  });
  it("refuses invalid key/timeout/command and cleans targeted sockets",async()=>{
    for(const options of [{key:"not-key",command:"/usr/bin/true",timeoutMs:1000},{key:inertPem,command:"\0bad",timeoutMs:1000},{key:inertPem,command:"/usr/bin/true",timeoutMs:1}]){
      const s=socket();await expect(executeSshCommand(s,await target(),options.key,options.command,{timeoutMs:options.timeoutMs})).rejects.toBeInstanceOf(SshExecutionError);expect(s.close).toHaveBeenCalled();
    }
    expect(fixture.requested).toBe(0);
  });
  it("bounds output and distinguishes truncation from successful exit",async()=>{
    fixture.data=2048;const result=await executeSshCommand(socket(),await target(),inertPem,"/usr/bin/true",{timeoutMs:1000,outputLimitBytes:1024});expect(result.stdout.length).toBe(1024);expect(result.truncated).toBe(true);expect(result.exit_code).toBe(0);
  });
  it("closes a pending Workers stream idempotently and releases locks",async()=>{
    const s=socket();const stream=new WorkersSocketStream(s,Date.now()+1000);await stream.close();await stream.close();expect(s.close).toHaveBeenCalledTimes(1);expect(s.readable.locked).toBe(false);expect(s.writable.locked).toBe(false);await expect(stream.write(Buffer.from("x"))).rejects.toThrow("WORKERS_SOCKET_STREAM_CLOSED");
  });
});
