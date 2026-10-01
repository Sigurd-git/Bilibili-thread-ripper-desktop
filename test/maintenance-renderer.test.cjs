"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");

test("a platform-unavailable result resolves the renderer check and permits retry",async()=>{
  const events={},messages=[],timers=new Map();let nextTimer=0;
  const api={getSettings:()=>({autoCheckUpdates:true}),onSettings:fn=>{fn({autoCheckUpdates:true});return ()=>{};}};
  const root={__BTR_DESKTOP__:api,postMessage:value=>messages.push(value),addEventListener:(type,fn)=>events[type]=fn};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../src/updates.js"),"utf8"),{globalThis:root,location:{origin:"https://bilipc.bilibili.com"},setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  const pending=api.checkUpdate();assert.equal(api.getUpdate().state,"checking");assert.equal(timers.size,1);
  const result={state:"platform-unavailable",message:"发布版本尚未提供 macOS 更新"};
  events.message({source:root,data:{channel:"__BTR_DESKTOP_UPDATE__",type:"result",result}});
  assert.equal((await pending).state,"platform-unavailable");assert.equal(api.getUpdate().message,result.message);assert.equal(timers.size,0);
  const retry=api.checkUpdate();assert.equal(api.getUpdate().state,"checking");
  assert.equal(messages.filter(value=>value.type==="check").length,2);
  events.message({source:root,data:{channel:"__BTR_DESKTOP_UPDATE__",type:"result",result:{state:"current",message:"当前已是最新版本"}}});
  assert.equal((await retry).state,"current");assert.equal(timers.size,0);
});
