"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const table = Array.from({length:256}, (_,i) => {
  let value=i; for(let bit=0;bit<8;bit++) value=value&1 ? 0xedb88320^(value>>>1) : value>>>1;
  return value>>>0;
});
function crc32(bytes) { let value=0xffffffff; for(const byte of bytes) value=table[(value^byte)&255]^(value>>>8); return (value^0xffffffff)>>>0; }

// Release packages are small, ordinary ZIPs. Reject ZIP64, symlinks and encrypted files,
// then verify each expanded body before writing anything into a newly created directory.
function readZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 24*1024*1024) throw Error("ZIP exceeds size limit");
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0 || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6)) throw Error("Invalid ZIP directory");
  const count=bytes.readUInt16LE(end+10), centralSize=bytes.readUInt32LE(end+12), centralStart=bytes.readUInt32LE(end+16);
  if(!count || count>128 || count!==bytes.readUInt16LE(end+8) || centralStart+centralSize!==end) throw Error("Invalid ZIP directory bounds");
  const files=[],seen=new Set(); let cursor=centralStart,total=0;
  for(let i=0;i<count;i++) {
    if(cursor+46>end || bytes.readUInt32LE(cursor)!==0x02014b50) throw Error("Invalid ZIP entry");
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24);
    const nameSize=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),mode=bytes.readUInt32LE(cursor+38)>>>16,local=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameSize+extra+comment>end || flags&1 || ![0,8].includes(method) || (mode&0xf000)===0xa000) throw Error("Unsupported ZIP entry");
    const name=bytes.toString("utf8",cursor+46,cursor+46+nameSize),key=name.toLowerCase();
    if(!/^BTR_Desktop\/[A-Za-z0-9_.\-/]*$/.test(name) || name.split("/").some((part,index,all)=>part==="."||part===".."||(!part&&index!==all.length-1)) || seen.has(key)) throw Error("Unsafe package entry");
    seen.add(key); total+=size; if(total>24*1024*1024) throw Error("Expanded package exceeds size limit");
    if(local+30>centralStart || bytes.readUInt32LE(local)!==0x04034b50) throw Error("Invalid local ZIP entry");
    const localName=bytes.readUInt16LE(local+26),start=local+30+localName+bytes.readUInt16LE(local+28);
    if(start+compressed>centralStart || bytes.toString("utf8",local+30,local+30+localName)!==name || bytes.readUInt16LE(local+6)!==flags || bytes.readUInt16LE(local+8)!==method) throw Error("Mismatched ZIP entry");
    const packed=bytes.subarray(start,start+compressed),body=method===8 ? zlib.inflateRawSync(packed,{maxOutputLength:Math.max(1,size)}) : packed;
    if(body.length!==size || crc32(body)!==crc) throw Error("ZIP checksum mismatch");
    if(name.endsWith("/") && size) throw Error("Invalid ZIP directory body");
    files.push({name,body,directory:name.endsWith("/")}); cursor+=46+nameSize+extra+comment;
  }
  if(cursor!==end) throw Error("Invalid ZIP directory size");
  const kinds=new Map(files.map(file=>[file.name.replace(/\/$/,"").toLowerCase(),file.directory]));
  for(const file of files) {
    const parts=file.name.split("/");
    for(let i=1;i<parts.length;i++) if(kinds.get(parts.slice(0,i).join("/").toLowerCase())===false) throw Error("ZIP file/directory conflict");
  }
  return files;
}
function extractZip(bytes, destination) {
  const files=readZip(bytes);
  fs.mkdirSync(destination, {recursive:false});
  for(const file of files) {
    const target=path.join(destination,...file.name.split("/"));
    fs.mkdirSync(file.directory?target:path.dirname(target),{recursive:true});
    if(!file.directory)fs.writeFileSync(target,file.body,{flag:"wx"});
  }
  return path.join(destination,"BTR_Desktop");
}
module.exports={crc32,readZip,extractZip};
