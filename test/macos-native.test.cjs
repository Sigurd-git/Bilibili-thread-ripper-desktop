"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {Asar,sha}=require("../tools/asar.cjs");
const mac=process.platform==="darwin";
function execute(file,args) {const result=spawnSync(file,args,{encoding:"utf8"});assert.equal(result.status,0,result.stderr);return result.stdout;}
function makeSource(dir) {
  const source=path.join(dir,"官方 源.app"),contents=path.join(source,"Contents"),resources=path.join(contents,"Resources");
  fs.mkdirSync(resources,{recursive:true});fs.mkdirSync(path.join(contents,"MacOS"));fs.copyFileSync("/bin/echo",path.join(contents,"MacOS","fixture"));
  const json=Buffer.from('{"files":{}}'),padded=Math.ceil((json.length+4)/4)*4,bytes=Buffer.alloc(padded+12);bytes.writeUInt32LE(4);bytes.writeUInt32LE(padded+4,4);bytes.writeUInt32LE(padded,8);bytes.writeUInt32LE(json.length,12);json.copy(bytes,16);
  const archive=new Asar(bytes);archive.set("package.json",'{"name":"bilibili","version":"1.19.0"}');archive.set("index.js","'use strict';\noriginal();");fs.writeFileSync(path.join(resources,"app.asar"),archive.pack());
  fs.writeFileSync(path.join(contents,"Info.plist"),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.bilibili.bilibiliPC</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1.19.0</string></dict></plist>`);
  execute("/usr/bin/codesign",["--force","--sign","-","--options","runtime",source]);return source;
}
test("native macOS install, repeat install, immutable maintenance copy and offline signature restoration",{skip:!mac},()=>{
  const {install,status,remove,bundleInfo}=require("../macos/installer.cjs");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-native-"));
  try {
    const source=makeSource(dir),client=path.join(dir,"BTR 客户端.app"),dataDir=path.join(dir,"维护 数据"),options={source,client,dataDir,noLaunch:true};
    const originalAsar=bundleInfo(source).hash,originalPlist=sha(fs.readFileSync(path.join(source,"Contents","Info.plist"))),originalExe=sha(fs.readFileSync(bundleInfo(source).executable));
    assert.equal(install(options).state,"installed");const report=status(options);assert.equal(report.state,"current");assert.equal(report.integrityMatches,true);assert.equal(report.signatureValid,true);
    const installed=bundleInfo(client);assert.equal(installed.installed.runtimePath,bundleInfo(source).executable);assert.ok(installed.installed.installRoot.startsWith(fs.realpathSync(dataDir)));assert.equal(bundleInfo(source).hash,originalAsar);
    assert.equal(install(options).state,"current");
    assert.throws(()=>install({...options,client:source}),/分开/);
    const current=fs.readFileSync(installed.target);fs.writeFileSync(installed.target,Buffer.from("damaged"));assert.throws(()=>remove(options));fs.writeFileSync(installed.target,current);
    assert.equal(remove(options).state,"removed");assert.equal(bundleInfo(client).hash,originalAsar);assert.equal(sha(fs.readFileSync(path.join(client,"Contents","Info.plist"))),originalPlist);assert.equal(sha(fs.readFileSync(bundleInfo(client).executable)),originalExe);
    execute("/usr/bin/codesign",["--verify","--deep","--strict",client]);assert.equal(status(options).state,"not-installed");assert.equal(remove(options).state,"not-installed");
    assert.equal(install(options).state,"installed");assert.equal(status(options).state,"current");assert.equal(remove(options).state,"removed");
    fs.rmSync(client,{recursive:true});assert.equal(install(options).state,"installed");assert.equal(status(options).state,"current");assert.equal(remove(options).state,"removed");
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test("native macOS rejects an invalid source signature without changing the deployed copy",{skip:!mac},()=>{
  const {install,status,bundleInfo}=require("../macos/installer.cjs"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"btr-rollback-"));
  try {
    const source=makeSource(dir),options={source,client:path.join(dir,"BTR.app"),dataDir:path.join(dir,"data"),noLaunch:true};install(options);
    const hash=bundleInfo(options.client).hash;const official=bundleInfo(source).hash;
    fs.writeFileSync(path.join(source,"Contents","Resources","unexpected.txt"),"invalidates the original signature");
    assert.throws(()=>install(options));assert.equal(bundleInfo(options.client).hash,hash);assert.equal(status(options).state,"current");assert.equal(bundleInfo(source).hash,official);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
