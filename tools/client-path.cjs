"use strict";
let fs;
try { fs = require("original-fs"); } catch (_) { fs = require("node:fs"); }
const path = require("node:path");

function resolveClient(clientPath) {
  if (!clientPath || !path.isAbsolute(clientPath)) throw Error("需要客户端绝对路径");
  // Check before realpath: resolving first would hide a symlink supplied as an ASAR.
  if (fs.lstatSync(clientPath).isSymbolicLink()) throw Error("不处理链接形式的客户端资源");
  const client = fs.realpathSync(clientPath);
  const directory = fs.statSync(client).isDirectory();
  const bundle = directory && client.endsWith(".app") ? client : null;
  const target = directory ? path.join(client, ...(bundle ? ["Contents", "Resources"] : ["resources"]), "app.asar") : client;
  if (path.extname(target) !== ".asar") throw Error("目标必须是客户端 ASAR 资源");
  if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile()) throw Error("不处理链接形式的客户端资源");
  if (fs.realpathSync(target) !== target) throw Error("客户端资源目录不能包含链接");
  return {client, target, bundle};
}

module.exports = {resolveClient};
