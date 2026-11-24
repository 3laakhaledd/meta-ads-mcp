import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as publishing from "../src/tools/organic-publishing.js";
const {registerOrganicPublishingTools,createMemoryPublishingState,createFilePublishingState}=publishing;
process.env.META_ADS_ACCESS_TOKEN="finish-test-system-token";
const args={page_id:"123",video_id:"789",description:"Exact original caption",cover_url:"https://cdn.example.org/original-cover.jpg"};
const bytes=new Uint8Array([255,216,255,1]);
const ready={id:"789",from:{id:"123",name:"SPEN"},privacy:{value:"EVERYONE"},published:true,status:{video_status:"upload_complete",uploading_phase:{status:"complete",bytes_transferred:42},processing_phase:{status:"not_started"},publishing_phase:{status:"not_started"}}};
function harness(options:any={},state=createMemoryPublishingState()){
 const tools:any={},calls:any[]=[];let video=structuredClone(options.video||ready),cover=bytes;
 registerOrganicPublishingTools({tool(n:string,_d:any,_s:any,h:any){tools[n]=h;}},async(method:any,path:any,params:any,token:any)=>{
  calls.push([method,path,params,token]);
  if(method==="GET"&&path==="/123")return {id:"123",access_token:"page-token"};
  if(method==="GET"&&path==="/789")return video;
  if(method==="POST"&&path==="/123/video_reels"&&params.upload_phase==="start")return {video_id:"789",upload_url:"https://rupload.facebook.com/video-upload/v26.0/789"};
  if(method==="POST"&&path==="/123/video_reels"&&params.upload_phase==="finish"){if(options.finishFail)throw Error("secret provider URL");return {success:true};}
  throw Error("Unexpected external call");
 },Date.now,{
  loadCover:async()=>{calls.push(["cover_read"]);return cover;},
  uploadVideo:async()=>{calls.push(["video_upload"]);},
  uploadCover:async()=>{calls.push(["thumbnail"]);if(options.coverFail)throw Error("secret thumbnail error");},
 },state);
 const run=async(n:string,a:any)=>{const r=await tools[n](a);return {error:!!r.isError,...JSON.parse(r.content[0].text)};};
 const approve=async(n:string,a:any)=>{const p=await run(n,a);return {...a,approval_token:p.approval_token,confidence:"approved"};};
 return {run,approve,calls,state,setVideo:(v:any)=>{video=v;},setCover:(v:Uint8Array)=>{cover=v;}};
}
test("completed upload is finished even while processing has not started",async()=>{
 const h=harness(),a={page_id:"123",video_url:"https://cdn.example.org/reel.mp4",description:args.description,cover_url:args.cover_url};
 const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",a));
 assert.equal(r.status,"publication_submitted");assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,1);
 assert.ok(h.calls.findIndex(c=>c[0]==="thumbnail")<h.calls.findIndex(c=>c[2]?.upload_phase==="finish"));
});
test("processing-in-progress does not deadlock the required finish request",async()=>{
 const h=harness({video:{...ready,status:{...ready.status,processing_phase:{status:"in_progress"}}}});
 const a={page_id:"123",video_url:"https://cdn.example.org/reel.mp4"};
 assert.equal((await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",a))).status,"publication_submitted");
});
test("incomplete upload cannot be finalised",async()=>{
 const h=harness({video:{...ready,status:{...ready.status,uploading_phase:{status:"in_progress"}}}}),a={page_id:"123",video_url:"https://cdn.example.org/reel.mp4"};
 assert.equal((await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",a))).status,"reel_not_published");
 assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,0);
});
test("provider phase errors block finish rather than being stripped as harmless not_started",async()=>{
 for(const phase of ["uploading_phase","processing_phase","publishing_phase"]){
  const v=structuredClone(ready) as any;v.status[phase].error={message:"secret format error"};const h=harness({video:v});const a={page_id:"123",video_url:"https://cdn.example.org/reel.mp4"};
  const r=await h.run("publish_facebook_reel",await h.approve("publish_facebook_reel",a));assert.equal(r.failure_code,"facebook_phase_error");
  assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,0);assert.ok(!JSON.stringify(r).includes("secret format error"));
 }
});
test("same-video recovery preview reads exact owner/status/cover and sends zero Meta mutations",async()=>{
 const h=harness();const p=await h.run("recover_facebook_reel_upload",args);
 assert.equal(p.status,"confirmation_required");assert.equal(p.preview.video_id,"789");assert.equal(p.preview.description,args.description);
 assert.equal(p.preview.target.privacy,"EVERYONE");assert.equal(p.preview.target.video_status,"upload_complete");assert.ok(p.preview.cover_sha256);
 assert.equal(h.calls.filter(c=>c[0]==="POST"||c[0]==="DELETE"||c[0]==="video_upload"||c[0]==="thumbnail").length,0);
 assert.ok(!JSON.stringify(p).includes("page-token"));
});
test("approved recovery finishes the same video with exact caption and cover without recreating or reuploading",async()=>{
 const h=harness();const r=await h.run("recover_facebook_reel_upload",await h.approve("recover_facebook_reel_upload",args));
 assert.equal(r.status,"publication_submitted");assert.equal(r.video_id,"789");
 assert.equal(h.calls.filter(c=>c[0]==="video_upload"||c[2]?.upload_phase==="start"||c[0]==="DELETE").length,0);
 const finish=h.calls.find(c=>c[2]?.upload_phase==="finish");assert.equal(finish[2].video_id,"789");assert.equal(finish[2].description,args.description);assert.equal(finish[3],"page-token");
 assert.equal(h.calls.filter(c=>c[0]==="thumbnail").length,1);
});
test("recovery rejects foreign owners, private videos, incomplete uploads and submitted publication",async()=>{
 for(const video of [{...ready,from:{id:"999"}},{...ready,privacy:{value:"SELF"}},{...ready,status:{...ready.status,uploading_phase:{status:"in_progress"}}},{...ready,status:{...ready.status,publishing_phase:{status:"in_progress"}}},{...ready,status:{...ready.status,publishing_phase:{status:"complete"}}}]){
  const h=harness({video});assert.equal((await h.run("recover_facebook_reel_upload",args)).error,true);assert.equal(h.calls.filter(c=>c[0]==="POST"||c[0]==="video_upload").length,0);
 }
});
test("changed caption, phase or fetched cover bytes invalidates recovery approval",async()=>{
 for(const change of ["caption","phase","cover"]){
  const h=harness(),a=await h.approve("recover_facebook_reel_upload",args);
  if(change==="phase")h.setVideo({...ready,status:{...ready.status,processing_phase:{status:"in_progress"}}});
  if(change==="cover")h.setCover(new Uint8Array([255,216,255,2]));
  const r=await h.run("recover_facebook_reel_upload",change==="caption"?{...a,description:"Changed"}:a);
  assert.equal(r.failure_code,"approval_content_mismatch");assert.equal(h.calls.filter(c=>c[0]==="POST"||c[0]==="thumbnail").length,0);
 }
});
test("known blocked, deleted or submitted local entries cannot be adopted by recovery",async()=>{
 for(const entry of [{owner:"123",blocked:true},{owner:"123",submitted:true},{owner:"123",deleted:true},{owner:"999"}]){
  const h=harness();h.state.reels.set("789",entry);assert.equal((await h.run("recover_facebook_reel_upload",args)).error,true);
  assert.equal(h.calls.filter(c=>c[0]==="POST").length,0);
 }
 const h=harness();h.state.deletions.set("789",{attempted:true});assert.equal((await h.run("recover_facebook_reel_upload",args)).error,true);
});
test("recovery survives independent file-state sessions and consumes a finish attempt once",async()=>{
 const root=mkdtempSync(join(tmpdir(),"meta-finish-recover-"));try{
  const a=harness({},createFilePublishingState(root)),approved=await a.approve("recover_facebook_reel_upload",args);
  const b=harness({},createFilePublishingState(root));assert.equal((await b.run("recover_facebook_reel_upload",approved)).status,"publication_submitted");
  const c=harness({},createFilePublishingState(root));assert.equal((await c.run("recover_facebook_reel_upload",args)).error,true);assert.equal(c.calls.filter(x=>x[0]==="POST").length,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("ambiguous recovery finish retains the video ID and prevents blind replay",async()=>{
 const h=harness({finishFail:true}),a=await h.approve("recover_facebook_reel_upload",args);
 const r=await h.run("recover_facebook_reel_upload",a);assert.equal(r.video_id,"789");assert.equal(r.failure_stage,"facebook_finish");
 assert.equal((await h.run("recover_facebook_reel_upload",args)).error,true);assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,1);
});
test("failed cover application blocks finalisation and preserves the same video ID",async()=>{
 const h=harness({coverFail:true}),a=await h.approve("recover_facebook_reel_upload",args);
 const r=await h.run("recover_facebook_reel_upload",a);assert.equal(r.video_id,"789");assert.equal(r.failure_stage,"facebook_thumbnail");
 assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,0);
});
test("recovery rejects creation/upload parameters rather than silently accepting them",async()=>{
 const h=harness();const r=await h.run("recover_facebook_reel_upload",{...args,video_url:"https://cdn.example.org/new.mp4"});
 assert.equal(r.failure_stage,"validation");assert.equal(h.calls.length,0);
});
test("concurrent recovery approvals submit one finish only",async()=>{
 const h=harness(),a=await h.approve("recover_facebook_reel_upload",args),b=await h.approve("recover_facebook_reel_upload",args);
 const results=await Promise.all([h.run("recover_facebook_reel_upload",a),h.run("recover_facebook_reel_upload",b)]);
 assert.equal(results.filter(r=>r.status==="publication_submitted").length,1);
 assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,1);
});
test("unknown processing phase cannot accidentally submit finish",async()=>{
 const h=harness({video:{...ready,status:{...ready.status,processing_phase:{status:"unexpected"}}}});
 assert.equal((await h.run("recover_facebook_reel_upload",args)).error,true);
 assert.equal(h.calls.filter(c=>c[2]?.upload_phase==="finish").length,0);
});
