"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),{spawn,spawnSync}=require("node:child_process"),{once}=require("node:events");
const installer=path.resolve(__dirname,"../macos/installer.cjs"),{withLock}=require(installer);
function fixture() {return fs.mkdtempSync(path.join(os.tmpdir(),"btr-lock-"));}
function contender(state,pid,owner) {
  const directory=path.join(state,"locks",`${pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory,{recursive:true});
  if(owner)fs.writeFileSync(path.join(directory,"owner.json"),JSON.stringify(owner));
  return directory;
}

test("active maintenance contenders block another action and remain owned by their process",()=>{
  const state=fixture();
  try {
    const active=contender(state,process.pid,{pid:process.pid,choosing:false,ticket:1});let entered=false;
    assert.throws(()=>withLock(state,()=>{entered=true;}),/维护任务正在运行/);assert.equal(entered,false);assert.ok(fs.existsSync(active));
    fs.rmSync(active,{recursive:true});assert.equal(withLock(state,()=>"released"),"released");
    const choosing=contender(state,process.pid,{pid:process.pid,choosing:true,ticket:0});
    assert.throws(()=>withLock(state,()=>{entered=true;}),/维护任务正在运行/);assert.equal(entered,false);assert.ok(fs.existsSync(choosing));
  } finally {fs.rmSync(state,{recursive:true,force:true});}
});

test("dead contenders are recovered even if their owner record was never committed",()=>{
  const state=fixture();
  try {
    const dead=spawnSync(process.execPath,["-e",""],{encoding:"utf8"});assert.equal(dead.status,0,dead.stderr);
    assert.throws(()=>process.kill(dead.pid,0),error=>error.code==="ESRCH");
    const unfinished=contender(state,dead.pid,null),choosing=contender(state,dead.pid,{pid:dead.pid,choosing:true,ticket:0}),committed=contender(state,dead.pid,{pid:dead.pid,choosing:false,ticket:3});
    assert.equal(withLock(state,()=>"recovered"),"recovered");
    for(const file of [unfinished,choosing,committed])assert.equal(fs.existsSync(file),false);
    assert.equal(withLock(state,()=>"again"),"again");
  } finally {fs.rmSync(state,{recursive:true,force:true});}
});

test("reentrant maintenance is rejected and action failures release ownership",()=>{
  const state=fixture();
  try {
    let nestedEntered=false;
    assert.equal(withLock(state,()=>{
      assert.throws(()=>withLock(state,()=>{nestedEntered=true;}),/维护任务正在运行/);
      assert.equal(nestedEntered,false);return "outer";
    }),"outer");
    assert.throws(()=>withLock(state,()=>{throw Error("action failed");}),/action failed/);
    assert.equal(withLock(state,()=>"next"),"next");
  } finally {fs.rmSync(state,{recursive:true,force:true});}
});

test("a process killed inside maintenance leaves recoverable ownership",{timeout:5000},async()=>{
  const state=fixture(),code=String.raw`const {withLock}=require(process.argv[1]);withLock(process.argv[2],()=>{process.send("entered");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});`;
  const child=spawn(process.execPath,["-e",code,installer,state],{stdio:["ignore","ignore","ignore","ipc"]});
  try {
    const [message]=await once(child,"message");assert.equal(message,"entered");
    assert.throws(()=>withLock(state,()=>"must stay blocked"),/维护任务正在运行/);
    const exited=once(child,"exit");child.kill("SIGKILL");await exited;
    assert.equal(withLock(state,()=>"recovered after crash"),"recovered after crash");
  } finally {
    if(child.pid && child.exitCode===null && child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}
    fs.rmSync(state,{recursive:true,force:true});
  }
});

const WORKER=String.raw`
const fs=require("node:fs"),path=require("node:path"),{withLock}=require(process.argv[1]);
const state=process.argv[2],sentinel=path.join(state,"critical"),pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
process.send({type:"ready"});
process.once("message",()=>{
  try {
    let completed=0;const deadline=Date.now()+5000;
    while(completed<3 && Date.now()<deadline) {
      try {
        withLock(state,()=>{
          let descriptor;
          try{descriptor=fs.openSync(sentinel,"wx");}catch(error){if(error.code==="EEXIST")throw Error("overlapping maintenance actions");throw error;}
          process.send({type:"entered"});
          try{pause(35);}finally{fs.closeSync(descriptor);fs.unlinkSync(sentinel);}
        });completed++;
      } catch(error) {if(!/维护任务正在运行/.test(error.message))throw error;pause(10+Math.floor(Math.random()*20));}
    }
    if(completed!==3)throw Error("contender made no progress before deadline");
    process.send({type:"done"});process.disconnect();
  } catch(error) {process.send({type:"error",message:error.message});process.exitCode=1;process.disconnect();}
});
`;

test("independent maintenance processes never overlap and recover a dead contender together",{timeout:10000},async()=>{
  const state=fixture(),children=[];
  try {
    const dead=spawnSync(process.execPath,["-e",""],{encoding:"utf8"});assert.equal(dead.status,0,dead.stderr);
    contender(state,dead.pid,{pid:dead.pid,choosing:false,ticket:1});
    const ready=[],finished=[];let entries=0;
    for(let index=0;index<4;index++) {
      const child=spawn(process.execPath,["-e",WORKER,installer,state],{stdio:["ignore","ignore","pipe","ipc"]});children.push(child);
      let stderr="",failure;
      child.stderr.on("data",bytes=>stderr+=bytes);
      ready.push(new Promise((resolve,reject)=>{child.on("error",reject);child.on("message",message=>{if(message.type==="ready")resolve();});child.once("exit",()=>reject(Error("worker exited before barrier")));}));
      child.on("message",message=>{if(message.type==="entered")entries++;if(message.type==="error")failure=message.message;});
      finished.push(new Promise((resolve,reject)=>{child.on("error",reject);child.once("exit",code=>code===0&&!failure?resolve():reject(Error(failure||stderr||`worker exit ${code}`)));}));
    }
    const done=Promise.all(finished);done.catch(()=>{});
    await Promise.all(ready);for(const child of children)child.send({type:"start"});
    await done;assert.equal(entries,12);assert.equal(fs.existsSync(path.join(state,"critical")),false);
    assert.equal(withLock(state,()=>"available after workers"),"available after workers");
  } finally {
    await Promise.all(children.map(async child=>{if(child.pid && child.exitCode===null && child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}}));
    fs.rmSync(state,{recursive:true,force:true});
  }
});
