import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as publishing from "../src/tools/organic-publishing.js";
const { createFilePublishingState, createMemoryPublishingState, registerOrganicPublishingTools, graphRequest } = publishing;
process.env.META_ADS_ACCESS_TOKEN = "state-test-system-token";
const fb={page_id:"123",message:"Same approved caption"};
const ig={ig_account_id:"456",media_type:"REELS",media_url:"https://cdn.example.org/reel.mp4",cover_url:"https://cdn.example.org/cover.jpg",caption:"Original caption"};
function fixture(){ const root=mkdtempSync(join(tmpdir(),"meta-publish-test-")); return {root,close:()=>rmSync(root,{recursive:true,force:true})}; }
function harness(state:any,replies:any[]=[],clock=Date.now,transport?:any){
  const tools:any={},calls:any[]=[];
  registerOrganicPublishingTools({tool(n:string,_d:any,_s:any,h:any){tools[n]=h;}},async(...args:any[])=>{
    calls.push(args);const r=replies.shift();if(!r||r.fail)throw new Error("secret-provider-token");return r;
  },clock,transport,state);
  const run=async(n:string,a:any)=>{const r=await tools[n](a);return {error:!!r.isError,...JSON.parse(r.content[0].text)};};
  return {run,calls};
}
test("an approval created by one MCP session executes in another without widening approved content",async()=>{
  const f=fixture();try{
    const first=harness(createFilePublishingState(f.root)); const p=await first.run("publish_facebook_post",fb);
    assert.equal(first.calls.length,0);
    const second=harness(createFilePublishingState(f.root),[{id:"123",access_token:"page-token"},{id:"123_789"}]);
    const a={...fb,approval_token:p.approval_token,confidence:"approved"};
    assert.equal((await second.run("publish_facebook_post",{...a,message:"Changed"})).failure_code,"approval_content_mismatch");
    assert.equal(second.calls.length,0);
    assert.equal((await second.run("publish_facebook_post",a)).status,"published");
    const third=harness(createFilePublishingState(f.root));
    const replay=await third.run("publish_facebook_post",a);
    assert.equal(replay.failure_stage,"approval");assert.equal(replay.meta_write_attempted,false);assert.equal(third.calls.length,0);
    assert.equal(statSync(f.root).mode&0o777,0o700);
  }finally{f.close();}
});
test("approval consumption is atomic across actual child processes",()=>{
  const f=fixture();try{
    const state=createFilePublishingState(f.root);const token="a".repeat(48);state.pending.set(token,{hash:"test-hash",expires:Date.now()+10000});
    const moduleURL=new URL("../src/tools/organic-publishing.js",import.meta.url).href;
    const code=`import {createFilePublishingState} from ${JSON.stringify(moduleURL)}; const s=createFilePublishingState(${JSON.stringify(f.root)});console.log(s.pending.delete(${JSON.stringify(token)}));`;
    const a=spawnSync(process.execPath,[...(import.meta.url.endsWith(".ts")?["--import","tsx"]:[]),"--input-type=module","-e",code],{encoding:"utf8"});
    const b=spawnSync(process.execPath,[...(import.meta.url.endsWith(".ts")?["--import","tsx"]:[]),"--input-type=module","-e",code],{encoding:"utf8"});
    assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);
    assert.equal(a.stdout.trim(),"true");assert.equal(b.stdout.trim(),"false");
  }finally{f.close();}
});
test("expired approvals are diagnosed before Meta calls",async()=>{
  const f=fixture();try{
    let now=0;const h=harness(createFilePublishingState(f.root),[],()=>now);
    const p=await h.run("publish_facebook_post",fb);now=600001;
    const r=await h.run("publish_facebook_post",{...fb,approval_token:p.approval_token,confidence:"approved"});
    assert.equal(r.failure_code,"approval_expired");assert.equal(r.meta_write_attempted,false);assert.equal(h.calls.length,0);
  }finally{f.close();}
});
test("Instagram containers and original cover-aware resume previews survive a new session",async()=>{
  const f=fixture();try{
    const h=harness(createFilePublishingState(f.root),[{id:"789"},{status_code:"IN_PROGRESS"}]);
    const p=await h.run("publish_instagram_post",ig);
    assert.equal((await h.run("publish_instagram_post",{...ig,approval_token:p.approval_token,confidence:"approved"})).creation_id,"789");
    const next=harness(createFilePublishingState(f.root),[{status_code:"FINISHED"},{id:"1000"}]);
    const args={ig_account_id:"456",creation_id:"789"};const preview=await next.run("publish_instagram_container",args);
    assert.equal(preview.preview.post.cover_url,ig.cover_url);assert.equal(preview.preview.post.caption,ig.caption);
    assert.equal((await next.run("publish_instagram_container",{...args,approval_token:preview.approval_token,confidence:"approved"})).status,"published");
    const third=harness(createFilePublishingState(f.root));assert.equal((await third.run("publish_instagram_container",args)).error,true);
  }finally{f.close();}
});
test("state locks exclude another session and can be released only by their owner",()=>{
  const f=fixture();try{
    const a=createFilePublishingState(f.root),b=createFilePublishingState(f.root);const release=a.claim("containers","789");
    assert.throws(()=>b.claim("containers","789"));release();const done=b.claim("containers","789");
    release();assert.throws(()=>a.claim("containers","789"));done();
    assert.throws(()=>a.pending.get("../../outside"));
  }finally{f.close();}
});
test("read-only diagnostics distinguish lost approval state without external requests",async()=>{
  const f=fixture();try{
    const a=harness(createFilePublishingState(f.root));const p=await a.run("publish_facebook_post",fb);
    const b=harness(createFilePublishingState(f.root));
    const active=await b.run("get_organic_publishing_diagnostics",{approval_token:p.approval_token});
    assert.equal(active.approval_state,"active");assert.equal(active.state_scope,"container_local");
    const missing=await b.run("get_organic_publishing_diagnostics",{approval_token:"f".repeat(48)});
    assert.equal(missing.approval_state,"missing_or_consumed");assert.equal(b.calls.length,0);
    assert.ok(!JSON.stringify(active).includes(p.approval_token));assert.ok(!JSON.stringify(active).includes(f.root));
  }finally{f.close();}
});
test("Meta failure diagnostics expose only numeric codes and the request stage",async()=>{
  const f=fixture(),original=globalThis.fetch;try{
    const tools:any={};registerOrganicPublishingTools({tool(n:string,_d:any,_s:any,h:any){tools[n]=h;}},graphRequest,Date.now,undefined,createFilePublishingState(f.root));
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:190,error_subcode:463,message:"secret-token https://private.example"}}),{status:403});
    const p=JSON.parse((await tools.publish_facebook_post(fb)).content[0].text);
    const r=JSON.parse((await tools.publish_facebook_post({...fb,approval_token:p.approval_token,confidence:"approved"})).content[0].text);
    assert.equal(r.failure_stage,"page_token");assert.equal(r.meta_code,190);assert.equal(r.meta_subcode,463);assert.equal(r.http_status,403);assert.equal(r.meta_write_attempted,false);
    assert.ok(!JSON.stringify(r).includes("secret-token"));assert.ok(!JSON.stringify(r).includes("private.example"));
  }finally{globalThis.fetch=original;f.close();}
});
test("ambiguous Facebook upload remains blocked and identifiable across sessions",async()=>{
  const f=fixture();try{
    const transport={loadCover:async()=>new Uint8Array([137,80,78,71,13,10,26,10]),uploadVideo:async()=>{throw Error("secret-token");},uploadCover:async()=>{throw Error("must not run");}};
    const h=harness(createFilePublishingState(f.root),[{id:"123",access_token:"page-token"},{video_id:"789",upload_url:"https://rupload.facebook.com/video-upload/v26.0/789"}],Date.now,transport);
    const reel={page_id:"123",video_url:ig.media_url,description:"Original",cover_url:"https://cdn.example.org/cover.png"};
    const p=await h.run("publish_facebook_reel",reel);const r=await h.run("publish_facebook_reel",{...reel,approval_token:p.approval_token,confidence:"approved"});
    assert.equal(r.video_id,"789");assert.equal(r.failure_stage,"facebook_upload");assert.equal(r.meta_write_attempted,true);
    const next=harness(createFilePublishingState(f.root));assert.equal((await next.run("publish_facebook_reel_upload",{page_id:"123",video_id:"789"})).error,true);assert.equal(next.calls.length,0);
  }finally{f.close();}
});
test("cover failure is distinguished from approval failure and does not attempt Meta writes",async()=>{
  const f=fixture();try{
    const transport={loadCover:async()=>{throw Error("secret local path");},uploadVideo:async()=>{},uploadCover:async()=>{}};
    const h=harness(createFilePublishingState(f.root),[],Date.now,transport);
    const args={page_id:"123",video_url:ig.media_url,cover_url:"https://cdn.example.org/cover.png"};
    const p=await h.run("publish_facebook_reel",args);const r=await h.run("publish_facebook_reel",{...args,approval_token:p.approval_token,confidence:"approved"});
    assert.equal(r.failure_stage,"cover_fetch");assert.equal(r.meta_write_attempted,false);assert.equal(h.calls.length,0);assert.ok(!JSON.stringify(r).includes("secret local path"));
  }finally{f.close();}
});
test("state directories cannot be symlinks or accessible to other users",()=>{
  const f=fixture(),link=f.root+"-link";try{
    symlinkSync(f.root,link,"dir");assert.throws(()=>createFilePublishingState(link));
    chmodSync(f.root,0o755);assert.throws(()=>createFilePublishingState(f.root));
    chmodSync(f.root,0o700);
  }finally{rmSync(link,{force:true});f.close();}
});
test("state records are private and symlink records cannot be read",()=>{
  const f=fixture();try{
    const state=createFilePublishingState(f.root),token="b".repeat(48);
    state.pending.set(token,{hash:"synthetic-hash",expires:123});
    assert.equal(statSync(join(f.root,`pending.${token}.json`)).mode&0o777,0o600);
    const other="c".repeat(48),outside=join(f.root,"outside.json");
    writeFileSync(outside,JSON.stringify({hash:"must-not-read",expires:999}),{mode:0o600});
    symlinkSync(outside,join(f.root,`pending.${other}.json`));
    assert.throws(()=>state.pending.get(other));
  }finally{f.close();}
});
test("Instagram tracking failure still returns the newly created container ID",async()=>{
  const state=createMemoryPublishingState();state.containers.set=()=>{throw Error("private disk details");};
  const h=harness(state,[{id:"789"}]);const p=await h.run("publish_instagram_post",ig);
  const r=await h.run("publish_instagram_post",{...ig,approval_token:p.approval_token,confidence:"approved"});
  assert.equal(r.creation_id,"789");assert.equal(r.status,"container_created_state_unknown");
  assert.equal(r.meta_write_attempted,true);assert.equal(h.calls.length,1);
  assert.ok(!JSON.stringify(r).includes("private disk details"));
});
test("Facebook tracking failure still returns the new video ID without uploading",async()=>{
  const state=createMemoryPublishingState();state.reels.set=()=>{throw Error("private disk details");};
  const transport={loadCover:async()=>new Uint8Array(),uploadVideo:async()=>{throw Error("must not run");},uploadCover:async()=>{}};
  const h=harness(state,[{id:"123",access_token:"page-token"},{video_id:"789",upload_url:"https://rupload.facebook.com/video-upload/v26.0/789"}],Date.now,transport);
  const args={page_id:"123",video_url:ig.media_url};const p=await h.run("publish_facebook_reel",args);
  const r=await h.run("publish_facebook_reel",{...args,approval_token:p.approval_token,confidence:"approved"});
  assert.equal(r.video_id,"789");assert.equal(r.status,"reel_action_unknown");assert.equal(h.calls.length,2);
  assert.ok(!JSON.stringify(r).includes("private disk details"));
});
