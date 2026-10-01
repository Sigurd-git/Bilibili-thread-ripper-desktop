"use strict";
// Node 16 compatible: the official Electron runtime can run this helper without Node/npm.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), https = require("node:https");
const {spawnSync} = require("node:child_process");
const {Asar, sha} = require("../tools/asar.cjs");
const {inspect, MAC_MAINTENANCE_FILES} = require("../tools/client-package.cjs");
const {resolveClient} = require("../tools/client-path.cjs");
const {check, RAW} = require("../tools/update-provider.cjs");
const {extractZip} = require("../tools/zip.cjs");
const project = path.resolve(__dirname,"..");
const defaultData = () => path.join(os.homedir(),"Library","Application Support","BTR_Desktop");
const defaultClient = () => path.join(os.homedir(),"Applications","Bilibili BTR.app");

function command(executable,args,options={}) {
  const result=spawnSync(executable,args,{encoding:"utf8",timeout:60000,maxBuffer:4*1024*1024,...options});
  if(result.error || result.status!==0) throw Error(result.error?.message || result.stderr?.trim() || `Command failed: ${path.basename(executable)}`);
  return result.stdout;
}
function bundleInfo(client) {
  const resolved=resolveClient(client);
  if(!resolved.bundle) throw Error("macOS 客户端必须是 .app 文件夹");
  client=resolved.client;
  const plist=JSON.parse(command("/usr/bin/plutil",["-convert","json","-o","-",path.join(client,"Contents","Info.plist")]));
  if(plist.CFBundleIdentifier!=="com.bilibili.bilibiliPC" || typeof plist.CFBundleExecutable!=="string" || /[\/\\\0]/.test(plist.CFBundleExecutable)) throw Error("目标不是官方 Bilibili macOS 客户端");
  const archive=Asar.open(resolved.target), info=inspect(archive);
  return {...resolved,...info,plist,archive,hash:sha(archive.bytes),executable:path.join(client,"Contents","MacOS",plist.CFBundleExecutable)};
}
function verifySignature(client) { command("/usr/bin/codesign",["--verify","--deep","--strict",client]); }
function updateIntegrity(client) {
  const info=bundleInfo(client),file=path.join(client,"Contents","Info.plist");
  // The digest covers the raw JSON header, exactly as Electron's getRawHeader().headerString.
  const integrity={...(info.plist.ElectronAsarIntegrity||{}),"Resources/app.asar":{algorithm:"SHA256",hash:info.archive.headerHash()}};
  command("/usr/bin/plutil",["-replace","ElectronAsarIntegrity","-json",JSON.stringify(integrity),file]);
  // Keep every executable's original entitlements and hardened-runtime flags. Signing nested
  // code with the same local identity keeps library validation working without disabling it.
  command("/usr/bin/codesign",["--force","--deep","--sign","-","--preserve-metadata=entitlements,flags",client]);
  verifySignature(client);
  if(bundleInfo(client).plist.ElectronAsarIntegrity["Resources/app.asar"].hash!==bundleInfo(client).archive.headerHash()) throw Error("ASAR 完整性自检失败");
}
function assertStopped(info) {
  const processes=command("/bin/ps",["-axo","pid=,comm="]);
  for(const line of processes.split("\n")) {
    const match=/^\s*(\d+)\s+(.+)$/.exec(line);
    if(match && Number(match[1])!==process.pid && match[2]===info.executable) throw Error("请先完全退出 BTR 客户端，再进行安装或还原");
  }
}
function atomicJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${process.pid}.tmp`;
  try {fs.writeFileSync(temp,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});fs.renameSync(temp,file);}
  finally {fs.rmSync(temp,{force:true});}
}
function readJson(file) {return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):null;}
function locations(options) {
  const canonical=filename=>{
    const absolute=path.resolve(filename);
    if(fs.existsSync(absolute))return fs.realpathSync(absolute);
    return path.join(canonical(path.dirname(absolute)),path.basename(absolute));
  };
  const client=canonical(options.client||defaultClient()),data=canonical(options.dataDir||defaultData());
  if(!client.endsWith(".app"))throw Error("--client 必须是 .app 路径");
  const state=path.join(data,"deployments",sha(client).slice(0,24));
  return {client,data,state,pointer:path.join(state,"current.json")};
}
function log(data,message) {
  const directory=path.join(data,"logs");fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,`${new Date().toISOString().slice(0,10)}.log`);
  fs.appendFileSync(file,`${new Date().toISOString()} ${message}\n`,{mode:0o600});
  console.log(message);return file;
}
function withLock(state,action) {
  const busy=()=>Error("另一个 BTR 维护任务正在运行，请稍后重试");
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==="ESRCH")return false;throw error;}};
  const locks=path.join(state,"locks");fs.mkdirSync(locks,{recursive:true,mode:0o700});
  // Every contender owns a unique path. Reaping a dead contender can never delete the
  // lock of a new process, unlike removing and recreating one shared lock directory.
  const id=`${process.pid}-${require("node:crypto").randomUUID()}`,claim=path.join(locks,id);
  fs.mkdirSync(claim,{mode:0o700});
  function contenders() {
    const found=[];
    for(const name of fs.readdirSync(locks).sort()) {
      if(name===id)continue;
      const match=/^(\d+)-[a-f0-9-]{36}$/.exec(name),directory=path.join(locks,name);
      if(!match)throw Error("维护锁目录包含未知记录");
      if(!alive(Number(match[1]))){fs.rmSync(directory,{recursive:true,force:true});continue;}
      let owner;
      try{owner=readJson(path.join(directory,"owner.json"));}catch(error){if(error.code==="ENOENT")continue;throw error;}
      if(!owner || owner.choosing || !Number.isSafeInteger(owner.ticket) || owner.ticket<1)throw busy();
      found.push({name,ticket:owner.ticket});
    }
    return found;
  }
  try {
    atomicJson(path.join(claim,"owner.json"),{pid:process.pid,choosing:true,ticket:0});
    const ticket=1+Math.max(0,...contenders().map(owner=>owner.ticket));
    atomicJson(path.join(claim,"owner.json"),{pid:process.pid,choosing:false,ticket});
    if(contenders().some(owner=>owner.ticket<ticket || (owner.ticket===ticket && owner.name<id)))throw busy();
    return action();
  } finally {fs.rmSync(claim,{recursive:true,force:true});}
}
function persistProject(source,data) {
  const config=readJson(path.join(source,"desktop.json")),payload=readJson(path.join(source,"dist","payload.json"));
  if(!config || !payload || config.version!==payload.version || sha(fs.readFileSync(path.join(source,"dist","desktop.js")))!==payload.sha256) throw Error("BTR 构建文件校验失败，请先运行 npm run build");
  const hashes=Object.fromEntries(MAC_MAINTENANCE_FILES.map(file=>[file,sha(fs.readFileSync(path.join(source,file)))]));
  const destination=path.join(data,"releases",`${config.version}-${sha(JSON.stringify(hashes)).slice(0,16)}`);
  if(!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
    const temporary=fs.mkdtempSync(path.join(path.dirname(destination),".stage-"));
    try {
      for(const file of MAC_MAINTENANCE_FILES) {const target=path.join(temporary,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,file),target);}
      fs.renameSync(temporary,destination);
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
  }
  for(const [file,hash] of Object.entries(hashes)) if(sha(fs.readFileSync(path.join(destination,file)))!==hash)throw Error("本地维护文件校验失败");
  return fs.realpathSync(destination);
}
function originalKey(info) {
  return sha(info.hash+sha(fs.readFileSync(path.join(info.client,"Contents","Info.plist")))+sha(fs.readFileSync(info.executable))+sha(fs.readFileSync(path.join(info.client,"Contents","_CodeSignature","CodeResources"))));
}
function chooseSource(options,pointer) {
  const candidate=options.source||pointer?.sourceClient||["/Applications/哔哩哔哩.app","/Applications/Bilibili.app",path.join(os.homedir(),"Applications","哔哩哔哩.app")].find(file=>fs.existsSync(file));
  if(!candidate)throw Error("没有找到官方客户端，请使用 --source /完整路径/哔哩哔哩.app");
  return bundleInfo(path.resolve(candidate));
}
function launch(client,options) {if(!options.noLaunch)command("/usr/bin/open",[client]);}

function install(options={},sourceProject=project) {
  const where=locations(options);
  return withLock(where.state,()=>{
    const pointer=readJson(where.pointer),source=chooseSource(options,pointer);
    if(source.client===where.client)throw Error("BTR 副本必须与官方原版分开，请选择其他 --client 路径");
    if(source.installed || !source.entry)throw Error("需要未修改且入口可识别的官方客户端作为 --source");
    verifySignature(source.client);
    if(fs.existsSync(where.client)) {
      const current=bundleInfo(where.client);assertStopped(current);
      if(!pointer || pointer.clientPath!==where.client || current.hash!==pointer.patchedSha256 || (pointer.state==="removed" && (current.installed || originalKey(current)!==pointer.sourceKey)))throw Error("目标与 BTR 安装记录不匹配，拒绝覆盖；请选择新的副本路径");
    }
    const release=persistProject(sourceProject,where.data),clientPackage=require(path.join(release,"tools","client-package.cjs"));
    if(fs.existsSync(where.client) && pointer?.state!=="removed" && pointer?.installRoot===release && pointer.sourceKey===originalKey(source) && clientPackage.run("status",where.client).current) {
      verifySignature(where.client);launch(where.client,options);return {state:"current",clientPath:where.client,version:readJson(path.join(release,"desktop.json")).version};
    }
    fs.mkdirSync(path.dirname(where.client),{recursive:true});
    const operation=fs.mkdtempSync(path.join(where.state,".operation-"));
    const stage=path.join(path.dirname(where.client),`.btr-${path.basename(operation)}.app`),previous=stage+".previous";
    const originalBundle=path.join(where.data,"backups",originalKey(source)+".app");
    const deployment=path.join(operation,"deployment");
    let swapped=false,hadPrevious=false;
    try {
      log(where.data,"正在复制官方客户端并保留原始签名备份");
      if(!fs.existsSync(originalBundle)) {fs.mkdirSync(path.dirname(originalBundle),{recursive:true});command("/usr/bin/ditto",[source.client,originalBundle]);}
      const original=bundleInfo(originalBundle);verifySignature(originalBundle);
      if(originalKey(original)!==originalKey(source))throw Error("官方客户端备份校验失败");
      command("/usr/bin/ditto",[originalBundle,stage]);
      log(where.data,"正在安装 BTR 资源并更新 ASAR 完整性和本地应用签名");
      const result=clientPackage.run("install",stage,{platform:"darwin",allowMacBundleMutation:true,statePath:deployment,pruneBackups:false,metadata:{runtimePath:source.executable,sourceClient:source.client,clientPath:where.client,dataRoot:where.data}});
      if(result.state!=="installed")throw Error(result.message||"客户端入口不受支持");
      updateIntegrity(stage);
      const record=readJson(path.join(deployment,"deployment.json"));
      const next={schema:1,state:"installed",clientPath:where.client,sourceClient:source.client,runtimePath:source.executable,sourceKey:originalKey(source),originalBundle,originalSha256:source.hash,patchedSha256:bundleInfo(stage).hash,installRoot:release,version:result.version,deploymentState:deployment};
      if(fs.existsSync(where.client)){fs.renameSync(where.client,previous);hadPrevious=true;}
      fs.renameSync(stage,where.client);swapped=true;
      try {atomicJson(where.pointer,{...next,deployment:record});}
      catch(error){fs.renameSync(where.client,stage);swapped=false;if(hadPrevious){fs.renameSync(previous,where.client);hadPrevious=false;}throw error;}
      if(hadPrevious){fs.rmSync(previous,{recursive:true});hadPrevious=false;}
      log(where.data,`BTR ${result.version} 已安装：${where.client}`);launch(where.client,options);
      return {state:"installed",version:result.version,clientVersion:source.clientVersion,clientPath:where.client,sourceClient:source.client,installRoot:release,backupPath:originalBundle};
    } finally {
      if(!swapped) {if(hadPrevious&&!fs.existsSync(where.client))fs.renameSync(previous,where.client);fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(operation,{recursive:true,force:true});}
    }
  });
}
function status(options={}) {
  const where=locations(options),pointer=readJson(where.pointer);
  if(!pointer || pointer.state==="removed" || !fs.existsSync(where.client))return {state:"not-installed",clientPath:where.client};
  const info=bundleInfo(where.client);
  if(info.hash!==pointer.patchedSha256)return {state:"changed-client",clientPath:where.client,message:"副本资源已改变，不能自动覆盖"};
  const report=require(path.join(pointer.installRoot,"tools","client-package.cjs")).run("status",where.client);
  verifySignature(where.client);
  return {state:report.current?"current":"needs-repair",version:pointer.version,clientVersion:info.clientVersion,clientPath:where.client,sourceClient:pointer.sourceClient,integrityMatches:info.plist.ElectronAsarIntegrity?.["Resources/app.asar"]?.hash===info.archive.headerHash(),signatureValid:true};
}
function remove(options={}) {
  const where=locations(options);
  return withLock(where.state,()=>{
    const pointer=readJson(where.pointer);
    if(!pointer || pointer.state==="removed")return {state:"not-installed",clientPath:where.client};
    const current=bundleInfo(where.client);assertStopped(current);
    if(current.hash!==pointer.patchedSha256 || current.installed?.originalSha256!==pointer.originalSha256)throw Error("当前副本与安装记录不匹配，拒绝覆盖");
    const original=bundleInfo(pointer.originalBundle);verifySignature(original.client);
    if(original.hash!==pointer.originalSha256 || original.installed || originalKey(original)!==pointer.sourceKey)throw Error("原始应用备份校验失败");
    const stage=path.join(path.dirname(where.client),`.btr-restore-${process.pid}.app`),previous=stage+".previous";
    try {
      log(where.data,"正在还原完整官方客户端和原始应用签名");command("/usr/bin/ditto",[original.client,stage]);verifySignature(stage);
      fs.renameSync(where.client,previous);
      try {fs.renameSync(stage,where.client);atomicJson(where.pointer,{...pointer,state:"removed",patchedSha256:pointer.originalSha256});}
      catch(error){fs.rmSync(where.client,{recursive:true,force:true});fs.renameSync(previous,where.client);throw error;}
      fs.rmSync(previous,{recursive:true});log(where.data,"BTR 已卸载；官方原版、账号数据及原始备份保留");launch(where.client,options);
      return {state:"removed",clientPath:where.client,originalSha256:pointer.originalSha256};
    } finally {fs.rmSync(stage,{recursive:true,force:true});}
  });
}
function download(url,limit) {
  if(!url.startsWith(RAW))throw Error("Unexpected download URL");
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{headers:{"User-Agent":"BTR-Desktop-macOS"}},response=>{
      if(response.statusCode!==200){response.resume();reject(Error(`下载失败，HTTP ${response.statusCode}`));return;}
      const chunks=[];let size=0;
      response.on("data",chunk=>{size+=chunk.length;if(size>limit){response.destroy(Error("下载超过大小限制"));return;}chunks.push(chunk);});
      response.on("error",reject);response.on("end",()=>resolve(Buffer.concat(chunks,size)));
    });
    const timer=setTimeout(()=>request.destroy(Error("下载超时")),90000);
    request.on("error",reject);request.on("close",()=>clearTimeout(timer));
  });
}
async function update(options={}) {
  const where=locations(options),pointer=readJson(where.pointer);
  if(!pointer || pointer.state==="removed")throw Error("找不到 BTR 安装记录，请重新安装");
  const config=readJson(path.join(project,"desktop.json")),result=await check(config.update,{version:pointer.version},undefined,"darwin");
  if(result.state!=="available")return result;
  if(options.version && (options.version!==result.manifest.version || options.sha256!==result.manifest.sha256))throw Error("更新清单已改变，请重新检查更新");
  log(where.data,`正在下载并校验 BTR ${result.manifest.version}`);
  const bytes=await download(result.manifest.downloadUrl,24*1024*1024);
  if(sha(bytes)!==result.manifest.sha256)throw Error("更新包 SHA-256 校验失败");
  fs.mkdirSync(where.data,{recursive:true});const temporary=fs.mkdtempSync(path.join(where.data,".download-"));
  try {
    const next=extractZip(bytes,path.join(temporary,"expanded"));
    if(readJson(path.join(next,"desktop.json"))?.version!==result.manifest.version)throw Error("更新包版本不匹配");
    return install(options,next);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
function parseArgs(args) {
  const action=args[0]||"install",options={};
  if(!["install","status","remove","update"].includes(action))throw Error("操作必须是 install、status、remove 或 update");
  for(let i=1;i<args.length;i++) {
    const key=args[i];
    if(key==="--no-launch"){options.noLaunch=true;continue;}
    const names={"--client":"client","--source":"source","--data-dir":"dataDir","--wait-pid":"waitPid","--version":"version","--sha256":"sha256"};
    if(!names[key] || !args[i+1] || args[i+1].startsWith("--"))throw Error(`未知或不完整的参数：${key}`);
    options[names[key]]=args[++i];
  }
  for(const key of ["client","source","dataDir"])if(options[key]&&!path.isAbsolute(options[key]))throw Error(`${key} 必须是绝对路径`);
  if(options.waitPid && (!/^\d+$/.test(options.waitPid)||Number(options.waitPid)<2||Number(options.waitPid)===process.pid))throw Error("无效的客户端 PID");
  return {action,options};
}
async function waitForClient(pid) {
  const until=Date.now()+30000;
  while(Date.now()<until) {
    try{process.kill(Number(pid),0);}catch(error){if(error.code==="ESRCH")return;throw error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("客户端未退出，未修改应用，请完全退出后重试");
}
async function main() {
  if(process.platform!=="darwin")throw Error("此安装器仅适用于 macOS；Windows 请使用 install.ps1");
  const {action,options}=parseArgs(process.argv.slice(2));
  if(options.waitPid)await waitForClient(options.waitPid);
  const result=await ({install,status,remove,update})[action](options);
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main().catch(error=>{try{log(defaultData(),`失败：${error.message}`);}catch(_){}console.error(error.message);process.exitCode=1;});
module.exports={install,status,remove,update,parseArgs,waitForClient,updateIntegrity,verifySignature,bundleInfo,withLock,persistProject};
