import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as publishing from "../src/tools/organic-publishing.js";
const {registerOrganicPublishingTools,createMemoryPublishingState,createFilePublishingState,graphRequest,uploadFacebookReel}=publishing;
process.env.META_ADS_ACCESS_TOKEN="synthetic-system-token";
const args={page_id:"123",video_id:"789"};
const incomplete={id:"789",from:{id:"123",name:"SPEN"},published:true,privacy:{value:"EVERYONE"},status:{video_status:"uploading",uploading_phase:{status:"in_progress"},processing_phase:{status:"not_started"},publishing_phase:{status:"not_started"}}};
const live={...incomplete,status:{...incomplete.status,video_status:"ready",processing_phase:{status:"complete"},publishing_phase:{status:"complete"}}};
function harness(options:any={},state=createMemoryPublishingState()){
 const tools:any={},calls:any[]=[];let video=options.video||incomplete;
 registerOrganicPublishingTools({tool(n:string,_d:any,_s:any,h:any){tools[n]=h;}},async(method:any,path:any,params:any,token:any)=>{
  calls.push([method,path,params,token]);
  if(method==="GET"&&path==="/123")return options.page||{id:"123",access_token:"page-scoped-token"};
  if(method==="GET"&&path==="/789")return options.videoGetter?options.videoGetter():video;
  if(method==="DELETE"){if(options.deleteFail)throw Error("private Meta credential");return options.deleteReply??{success:true};}
  throw Error("Unexpected external call");
 },Date.now,undefined,state);
 const run=async(n:string,a:any)=>{const r=await tools[n](a);return {error:!!r.isError,...JSON.parse(r.content[0].text)};};
 const approve=async(a:any=args)=>{const p=await run("delete_facebook_page_video",a);return {...a,approval_token:p.approval_token,confidence:"approved"};};
 return {run,approve,calls,state,setVideo:(v:any)=>{video=v;}};
}
test("Page deletion preview resolves Page authorisation and ownership with zero DELETE calls",async()=>{
 const h=harness();const p=await h.run("delete_facebook_page_video",args);
 assert.equal(p.status,"confirmation_required");assert.equal(p.preview.target.owner_id,"123");
 assert.equal(p.preview.target.video_id,"789");assert.equal(p.preview.target.publishing,"not_started");
 assert.equal(p.preview.allow_published,false);assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,0);
 assert.equal(h.calls[1][3],"page-scoped-token");assert.ok(!JSON.stringify(p).includes("page-scoped-token"));
});
test("confirmed deletion uses the destination Page token, not the general ads token",async()=>{
 const h=harness();const a=await h.approve();const r=await h.run("delete_facebook_page_video",a);
 assert.equal(r.status,"deleted");assert.equal(r.page_id,"123");assert.equal(r.video_id,"789");
 const d=h.calls.filter(c=>c[0]==="DELETE");assert.equal(d.length,1);
 assert.deepEqual(d[0],["DELETE","/789",{},"page-scoped-token"]);
 assert.ok(!JSON.stringify(r).includes("page-scoped-token"));
});
test("foreign owners and mismatched Page authorisation cannot receive a deletion preview",async()=>{
 for(const options of [{video:{...incomplete,from:{id:"999"}}},{page:{id:"999",access_token:"wrong-page"}},{page:{id:"123"}},{video:{...incomplete,from:undefined}}]){
  const h=harness(options);assert.equal((await h.run("delete_facebook_page_video",args)).error,true);
  assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,0);
 }
});
test("live or unknown publication state is refused unless explicitly included in approval",async()=>{
 for(const video of [live,{...incomplete,status:undefined}]){
  const h=harness({video});const refused=await h.run("delete_facebook_page_video",args);
  assert.equal(refused.failure_code,"live_or_unknown_delete_not_allowed");
  const p=await h.run("delete_facebook_page_video",{...args,allow_published:true});assert.equal(p.status,"confirmation_required");
  assert.equal(p.preview.allow_published,true);assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,0);
 }
});
test("phase changes after preview invalidate deletion approval before the DELETE",async()=>{
 const h=harness();const a=await h.approve({...args,allow_published:true});h.setVideo(live);
 const r=await h.run("delete_facebook_page_video",a);assert.equal(r.failure_code,"approval_content_mismatch");
 assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,0);
});
test("deletion approval cannot be replayed or used across action types",async()=>{
 const h=harness();const a=await h.approve();assert.equal((await h.run("delete_facebook_page_video",a)).status,"deleted");
 assert.equal((await h.run("delete_facebook_page_video",a)).error,true);
 assert.equal((await h.run("delete_facebook_page_video",args)).error,true);
 assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,1);
});
test("ambiguous deletion is persisted and a second session cannot blindly retry",async()=>{
 const state=createMemoryPublishingState(),h=harness({deleteFail:true},state);const a=await h.approve();
 const r=await h.run("delete_facebook_page_video",a);assert.equal(r.failure_stage,"facebook_delete");assert.equal(r.meta_write_attempted,true);
 assert.ok(!JSON.stringify(r).includes("private Meta credential"));
 const next=harness({},state);assert.equal((await next.run("delete_facebook_page_video",args)).failure_code,"deletion_requires_reconciliation");
 assert.equal(next.calls.filter(c=>c[0]==="DELETE").length,0);
});
test("a false deletion response never reports success",async()=>{
 const h=harness({deleteReply:{success:false}});const r=await h.run("delete_facebook_page_video",await h.approve());
 assert.equal(r.error,true);assert.notEqual(r.status,"deleted");
});
test("successful deletion tombstones a tracked Facebook upload",async()=>{
 const h=harness();h.state.reels.set("789",{owner:"123",content:{},blocked:true,submitted:false});
 await h.run("delete_facebook_page_video",await h.approve());
 assert.equal(h.state.reels.get("789").deleted,true);assert.equal(h.state.reels.get("789").blocked,true);
});
test("the Graph DELETE transport keeps Page credentials in headers, never URLs",async()=>{
 const old=globalThis.fetch,calls:any[]=[];globalThis.fetch=async(u:any,i:any)=>{calls.push([String(u),i]);return new Response("{\"success\":true}",{status:200});};
 try{await graphRequest("DELETE","/789",{},"page-only-secret");assert.equal(calls[0][1].method,"DELETE");assert.equal(calls[0][1].headers.Authorization,"Bearer page-only-secret");assert.ok(!calls[0][0].includes("page-only-secret"));assert.equal(calls[0][1].redirect,"error");}
 finally{globalThis.fetch=old;}
});
test("upload timeout, DNS, TLS and connection failures return safe distinct codes",async()=>{
 const old=globalThis.fetch;try{
  for(const [error,code] of [[Object.assign(Error("private URL"),{name:"TimeoutError"}),"upload_timeout"],[Object.assign(Error("secret token"),{cause:{code:"ENOTFOUND"}}),"upload_dns_failed"],[Object.assign(Error("private cert"),{cause:{code:"CERT_HAS_EXPIRED"}}),"upload_tls_failed"],[Object.assign(Error("secret socket"),{cause:{code:"ECONNRESET"}}),"upload_connection_failed"]] as const){
   globalThis.fetch=async()=>{throw error;};
   await assert.rejects(()=>uploadFacebookReel("https://rupload.facebook.com/video-upload/v26.0/789","789","https://cdn.example.org/reel.mp4","page-secret"),(e:any)=>{assert.equal(e.code,code);assert.ok(!JSON.stringify(e).includes("private URL"));assert.ok(!JSON.stringify(e).includes("secret token"));return true;});
  }
 }finally{globalThis.fetch=old;}
});
test("non-JSON upload responses retain safe HTTP status, not body text",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response("secret html body",{status:502});
 try{await assert.rejects(()=>uploadFacebookReel("https://rupload.facebook.com/video-upload/v26.0/789","789","https://cdn.example.org/reel.mp4","page-secret"),(e:any)=>{assert.equal(e.code,"upload_non_json_response");assert.equal(e.meta.http_status,502);assert.ok(!JSON.stringify(e).includes("secret html"));return true;});}finally{globalThis.fetch=old;}
});
test("Meta-returned upload versions and trailing slash are accepted only on the fixed host and video ID",async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response("{\"success\":true}",{status:200});};
 try{await uploadFacebookReel("https://rupload.facebook.com/video-upload/v25.0/789/","789","https://cdn.example.org/reel.mp4","page-secret");
  await assert.rejects(()=>uploadFacebookReel("https://rupload.facebook.com/video-upload/v25.0/999/","789","https://cdn.example.org/reel.mp4","page-secret"));assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});
test("upload URL validation errors are distinguishable without exposing destination URLs",async()=>{
 await assert.rejects(()=>uploadFacebookReel("https://evil.example/video-upload/789","789","https://cdn.example.org/reel.mp4","secret"),(e:any)=>{assert.equal(e.code,"upload_destination_rejected");assert.ok(!JSON.stringify(e).includes("evil.example"));return true;});
});
test("deletion approvals and consumed tombstones persist across independent file-state sessions",async()=>{
 const root=mkdtempSync(join(tmpdir(),"meta-page-delete-"));try{
  const first=harness({},createFilePublishingState(root));const a=await first.approve();
  const second=harness({},createFilePublishingState(root));assert.equal((await second.run("delete_facebook_page_video",a)).status,"deleted");
  const third=harness({},createFilePublishingState(root));assert.equal((await third.run("delete_facebook_page_video",args)).failure_code,"deletion_requires_reconciliation");
  assert.equal(third.calls.length,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("concurrent approved deletions issue only one DELETE",async()=>{
 const h=harness();const a=await h.approve(),b=await h.approve();
 const results=await Promise.all([h.run("delete_facebook_page_video",a),h.run("delete_facebook_page_video",b)]);
 assert.equal(results.filter(r=>r.status==="deleted").length,1);assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,1);
});
test("ownership is rechecked under the mutation lock immediately before deletion",async()=>{
 let reads=0;const h=harness({videoGetter:()=>++reads>=3?{...incomplete,from:{id:"999"}}:incomplete});
 const a=await h.approve();const r=await h.run("delete_facebook_page_video",a);
 assert.equal(r.failure_code,"page_video_owner_mismatch");assert.equal(h.calls.filter(c=>c[0]==="DELETE").length,0);
});
test("Meta upload rejection retains numeric error codes without raw error text",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:10,error_subcode:1363055,message:"secret credential private URL"}}),{status:403});
 try{await assert.rejects(()=>uploadFacebookReel("https://rupload.facebook.com/video-upload/v26.0/789","789","https://cdn.example.org/reel.mp4","secret"),(e:any)=>{assert.equal(e.code,"meta_rejected");assert.equal(e.meta.meta_code,10);assert.equal(e.meta.meta_subcode,1363055);assert.ok(!JSON.stringify(e).includes("private URL"));return true;});}finally{globalThis.fetch=old;}
});
test("redirect refusal has a fixed diagnostic label without exposing the redirect",async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>{throw Object.assign(Error("fetch failed"),{cause:Error("unexpected redirect to secret URL")});};
 try{await assert.rejects(()=>uploadFacebookReel("https://rupload.facebook.com/video-upload/v26.0/789","789","https://cdn.example.org/reel.mp4","secret"),(e:any)=>{assert.equal(e.code,"upload_redirect_rejected");assert.ok(!JSON.stringify(e).includes("secret URL"));return true;});}finally{globalThis.fetch=old;}
});
