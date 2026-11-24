import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import * as publishing from "../src/tools/organic-publishing.js";
const { registerOrganicPublishingTools, uploadFacebookReel, uploadFacebookCover, isPublicIPv4, loadFacebookCover } = publishing;
process.env.META_ADS_ACCESS_TOKEN = "test-system-token";
const reel = { page_id: "123", video_url: "https://cdn.example.org/reel.mp4", description: "Exact caption", cover_url: "https://cdn.example.org/cover.png" };
const ig = { ig_account_id: "456", media_type: "REELS", media_url: reel.video_url, cover_url: "https://cdn.example.org/cover.jpg", caption: "Exact caption" };
const ready = { status: { uploading_phase: { status: "complete" }, processing_phase: { status: "complete" }, publishing_phase: { status: "not_started" } } };
function harness(replies: any[] = [], options: any = {}) {
  const tools: any = {}, calls: any[] = [];
  registerOrganicPublishingTools({ tool(n: string, _d: any, _s: any, h: any) { tools[n] = h; } }, async (...a: any[]) => {
    calls.push(a); const r = replies.shift(); if (!r || r.fail) throw Error("private-token"); return r;
  }, options.now || Date.now, {
    loadCover: async () => { calls.push(["cover-read"]); if (options.coverFail) throw Error("unsafe image"); return new Uint8Array([137,80,78,71,13,10,26,10]); },
    uploadVideo: async (...a: any[]) => { calls.push(["upload", ...a]); if (options.uploadFail) throw Error("private-token"); },
    uploadCover: async (...a: any[]) => { calls.push(["thumbnail", ...a]); if (options.thumbnailFail) throw Error("private-token"); },
  });
  async function run(n: string, a: any) { const r = await tools[n](a); return { error: !!r.isError, ...JSON.parse(r.content[0].text) }; }
  async function approve(n: string, a: any) { const p = await run(n,a); return { ...a, approval_token:p.approval_token, confidence:"approved" }; }
  return { tools, calls, run, approve };
}
const initial = [{ id: "123", access_token: "page-token" }, { video_id: "789", upload_url: "https://rupload.facebook.com/video-upload/v26.0/789" }];
test("Instagram custom cover is previewed, approval-bound and forwarded only for Reels", async () => {
  const h = harness([{ id:"789" }, { status_code:"IN_PROGRESS" }]);
  const a = await h.approve("publish_instagram_post",ig);
  assert.equal(h.calls.length,0);
  assert.equal((await h.run("publish_instagram_post",{...a,cover_url:"https://cdn.example.org/changed.jpg"})).error,true);
  assert.equal((await h.run("publish_instagram_post",a)).status,"container_not_published");
  assert.equal(h.calls[0][2].cover_url,ig.cover_url);
  const bad = harness();
  assert.equal((await bad.run("publish_instagram_post",{...ig,media_type:"IMAGE"})).error,true);
  assert.equal(bad.calls.length,0);
});
test("Facebook Reel preview has public audience, exact caption/cover and zero I/O", async () => {
  const h=harness(); const p=await h.run("publish_facebook_reel",reel);
  assert.equal(p.status,"confirmation_required"); assert.equal(p.preview.cover_url,reel.cover_url);
  assert.equal(p.preview.description,reel.description); assert.equal(p.preview.audience,"PUBLIC");
  assert.equal(h.calls.length,0);
});
test("Facebook uploads with Page token, sets cover before finish, and does not claim publication early", async () => {
  const h=harness([...initial,ready,{success:true}]);
  const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  assert.equal(r.status,"publication_submitted"); assert.equal(r.video_id,"789");
  const upload=h.calls.find(c=>c[0]==="upload"); assert.equal(upload[4],"page-token");
  assert.equal(h.calls.find(c=>c[0]==="thumbnail")[3],"page-token");
  const finish=h.calls.find(c=>c[2]?.upload_phase==="finish");
  assert.deepEqual(finish,["POST","/123/video_reels",{upload_phase:"finish",video_state:"PUBLISHED",video_id:"789",description:reel.description},"page-token"]);
  assert.ok(h.calls.findIndex(c=>c[0]==="thumbnail")<h.calls.indexOf(finish));
  assert.ok(!JSON.stringify(r).includes("page-token"));
});
test("processing Facebook Reel resumes same video with original caption and cover after fresh approval", async () => {
  const waiting={status:{uploading_phase:{status:"complete"},processing_phase:{status:"in_progress"}}};
  const h=harness([...initial,waiting,{id:"123",access_token:"page-token"},ready,{success:true}]);
  const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  assert.equal(r.status,"reel_not_published");
  const args={page_id:"123",video_id:"789"}; const p=await h.run("publish_facebook_reel_upload",args);
  assert.equal(p.preview.reel.description,reel.description); assert.equal(p.preview.reel.cover_url,reel.cover_url);
  assert.equal((await h.run("publish_facebook_reel_upload",{...args,approval_token:p.approval_token,confidence:"approved"})).status,"publication_submitted");
  assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="start").length,1);
  assert.equal(h.calls.filter(c=>c[0]==="upload").length,1);
});
test("cover substitution, expired/replayed and cross-platform approvals cannot write", async () => {
  let now=0; const h=harness([], {now:()=>now}); const a=await h.approve("publish_facebook_reel",reel);
  for(const change of [{cover_url:"https://cdn.example.org/other.png"},{page_id:"999"},{description:"Changed"}])
    assert.equal((await h.run("publish_facebook_reel",{...a,...change})).error,true);
  assert.equal((await h.run("publish_instagram_post",{...ig,approval_token:a.approval_token,confidence:"approved"})).error,true);
  now=600001; assert.equal((await h.run("publish_facebook_reel",a)).error,true); assert.equal(h.calls.length,0);
});
test("cover fetch failure performs no Meta calls and does not silently omit cover", async()=>{
  const h=harness([], {coverFail:true}); const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  assert.equal(r.error,true); assert.deepEqual(h.calls,[["cover-read"]]);
});
test("ambiguous video upload retains ID and is never automatically replayed or finished", async()=>{
  const h=harness(initial.slice(),{uploadFail:true}); const a=await h.approve("publish_facebook_reel",reel);
  const r=await h.run("publish_facebook_reel",a); assert.equal(r.video_id,"789"); assert.equal(r.status,"reel_action_unknown");
  assert.equal((await h.run("publish_facebook_reel",a)).error,true);
  assert.equal((await h.run("publish_facebook_reel_upload",{page_id:"123",video_id:"789"})).error,true);
  assert.equal(h.calls.filter(c=>c[0]==="upload").length,1);
});
test("thumbnail failure blocks finish and keeps the reconciliation ID",async()=>{
  const h=harness([...initial,ready],{thumbnailFail:true});
  const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  assert.equal(r.status,"reel_action_unknown"); assert.equal(r.video_id,"789");
  assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,0);
});
test("foreign Page/video cannot resume or read tracked uploads",async()=>{
  const h=harness(); for(const args of [{page_id:"999",video_id:"789"},{page_id:"123",video_id:"111"}]) {
    assert.equal((await h.run("publish_facebook_reel_upload",args)).error,true);
    assert.equal((await h.run("get_facebook_reel_status",args)).error,true);
  } assert.equal(h.calls.length,0);
});
test("private, reserved, mapped and malformed IPs are not cover fetch targets",()=>{
  for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","172.16.0.1","192.168.0.1","100.64.0.1","0.0.0.0","224.1.1.1","192.0.2.1","198.51.100.1","203.0.113.1","::1","::ffff:127.0.0.1","999.2.3.4"])
    assert.equal(isPublicIPv4(ip),false,ip);
  assert.equal(isPublicIPv4("8.8.8.8"),true);
});
test("video transport rejects untrusted hosts/redirects before sending credentials",async()=>{
  const original=globalThis.fetch, calls:any[]=[];
  globalThis.fetch=async (u:any,i:any)=>{calls.push([String(u),i]);return new Response(`{"success":true}`,{status:200});};
  try {
    for(const url of ["https://evil.example/video-upload/789","https://rupload.facebook.com.evil.example/video-upload/789","https://rupload.facebook.com/video-upload/999","http://rupload.facebook.com/video-upload/789","https://user:pass@rupload.facebook.com/video-upload/789"])
      await assert.rejects(()=>uploadFacebookReel(url,"789",reel.video_url,"page-secret"));
    assert.equal(calls.length,0);
    await uploadFacebookReel(initial[1].upload_url!,"789",reel.video_url,"page-secret");
    assert.equal(calls[0][1].redirect,"error"); assert.equal(calls[0][1].headers.file_url,reel.video_url);
    assert.equal(calls[0][1].headers.Authorization,"OAuth page-secret");
    await uploadFacebookCover("789",new Uint8Array([137,80,78,71,13,10,26,10]),"page-secret");
    assert.equal(calls[1][1].body.get("is_preferred"),"true"); assert.ok(calls[1][1].body.get("source") instanceof Blob);
    assert.ok(calls.every(c=>!c[0].includes("page-secret")));
  } finally {globalThis.fetch=original;}
});
test("cover fetch rejects private/mixed DNS answers before connection and pins a public connection",async()=>{
  let connections=0; let lookup:any;
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  const get:any=(_url:any,options:any,callback:any)=>{
    connections++; lookup=options.lookup;
    queueMicrotask(()=>{ const response:any=Readable.from([bytes]); response.statusCode=200;
      response.headers={"content-type":"image/png","content-length":"8"}; callback(response); });
    return new EventEmitter();
  };
  for(const addresses of [["127.0.0.1"],["8.8.8.8","169.254.169.254"]])
    await assert.rejects(()=>loadFacebookCover(reel.cover_url, (async()=>addresses) as any,get));
  assert.equal(connections,0);
  assert.deepEqual(await loadFacebookCover(reel.cover_url,(async()=>["8.8.8.8"]) as any,get),bytes);
  lookup("cdn.example.org",{},(error:any,address:any,family:any)=>{assert.equal(error,null);assert.equal(address,"8.8.8.8");assert.equal(family,4);});
  lookup("cdn.example.org",{all:true},(error:any,addresses:any)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:"8.8.8.8",family:4}]);});
});
test("cover fetch refuses redirects, oversized bodies and spoofed image types",async()=>{
  for(const item of [
    {status:302,type:"image/png",chunks:[Buffer.from("redirect")]},
    {status:200,type:"text/html",chunks:[Buffer.from("<html>")]},
    {status:200,type:"image/png",chunks:[Buffer.from("<svg>")]},
    {status:200,type:"image/png",chunks:[Buffer.alloc(8*1024*1024+1)]},
  ]){
    const get:any=(_url:any,_options:any,callback:any)=>{
      queueMicrotask(()=>{ const r:any=Readable.from(item.chunks);r.statusCode=item.status;r.headers={"content-type":item.type};callback(r);});
      return new EventEmitter();
    };
    await assert.rejects(()=>loadFacebookCover(reel.cover_url,(async()=>["8.8.8.8"]) as any,get));
  }
});
test("Facebook status requires publishing complete, sanitizes errors and never mutates",async()=>{
  const h=harness([...initial,{status:{uploading_phase:{status:"in_progress"}}},
    {id:"123",access_token:"page-token"},{status:{publishing_phase:{status:"in_progress",error:{message:"page-token"}}}},
    {id:"123",access_token:"page-token"},{status:{publishing_phase:{status:"complete"}}}]);
  await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  const before=h.calls.filter(c=>c[0]==="POST").length;
  const pending=await h.run("get_facebook_reel_status",{page_id:"123",video_id:"789"});
  assert.notEqual(pending.status,"published");assert.ok(!JSON.stringify(pending).includes("page-token"));
  assert.equal((await h.run("get_facebook_reel_status",{page_id:"123",video_id:"789"})).status,"published");
  assert.equal(h.calls.filter(c=>c[0]==="POST").length,before);
});
test("resume approval replay cannot finish twice",async()=>{
  const h=harness([...initial,{status:{uploading_phase:{status:"in_progress"}}},{id:"123",access_token:"page-token"},ready,{success:true}]);
  await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",reel));
  const a=await h.approve("publish_facebook_reel_upload",{page_id:"123",video_id:"789"});
  assert.equal((await h.run("publish_facebook_reel_upload",a)).status,"publication_submitted");
  assert.equal((await h.run("publish_facebook_reel_upload",a)).error,true);
  assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,1);
});
