"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {Asar,sha}=require("../tools/asar.cjs");
const {patch,run}=require("../tools/client-package.cjs");
const {resolveClient}=require("../tools/client-path.cjs");
function archive() {
  const json=Buffer.from('{"files":{}}'),padded=Math.ceil((json.length+4)/4)*4,bytes=Buffer.alloc(padded+12);
  bytes.writeUInt32LE(4);bytes.writeUInt32LE(padded+4,4);bytes.writeUInt32LE(padded,8);bytes.writeUInt32LE(json.length,12);json.copy(bytes,16);
  const asar=new Asar(bytes);asar.set("package.json",'{"name":"bilibili","version":"1.19.0"}');asar.set("index.js","original();");return asar;
}
test("a macOS bundle resolves capitalized Resources, and direct mutation requires the signed installer",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-path-")),client=path.join(dir,"客户端 with spaces.app"),target=path.join(client,"Contents","Resources","app.asar");
  try {
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,archive().pack());
    assert.equal(resolveClient(client).target,fs.realpathSync(target));assert.equal(run("status",client).supported,true);
    const before=sha(fs.readFileSync(target));assert.throws(()=>run("install",client),/install.sh/);assert.equal(sha(fs.readFileSync(target)),before);
    if(process.platform!=="win32") {
      const link=path.join(dir,"linked.asar");fs.symlinkSync(target,link);assert.throws(()=>resolveClient(link),/链接/);
      fs.unlinkSync(target);fs.symlinkSync(link,target);assert.throws(()=>resolveClient(client),/链接/);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("ASAR edits preserve shebang and strict directives after comments",()=>{
  for(const entry of ["#!/usr/bin/env node\n'use strict';\noriginal();","// entry comment\n/* another */\n\"use strict\";\noriginal();"]) {
    const original=archive();original.set("index.js",entry);
    const result=new Asar(patch(new Asar(original.pack()),Buffer.from("x"),{})).text("index.js");
    assert.ok(result.startsWith(entry.slice(0,entry.indexOf("original();"))));
    assert.match(result,/try\{require\(.+bootstrap.cjs/);assert.ok(result.endsWith("original();"));
  }
});
test("ASAR prototype-like names remain ordinary files and bad block sizes fail",()=>{
  const original=archive();original.set("__proto__/marker.txt","safe");original.set("constructor/file.txt","ordinary");
  const result=new Asar(original.pack());assert.equal(result.text("__proto__/marker.txt"),"safe");assert.equal({}.marker,undefined);assert.equal(result.entry("toString"),undefined);
  result.entry("index.js").integrity.blockSize=-1;assert.throws(()=>result.pack(),/block size/);
  result.entry("index.js").integrity.blockSize=0;assert.throws(()=>result.pack(),/block size/);
  assert.equal(original.headerHash(),sha(original.bytes.subarray(16,16+original.bytes.readUInt32LE(12))));
});
module.exports={archive};
