"use strict";
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto"), { spawnSync } = require("node:child_process");
const project = path.resolve(__dirname, "..");
const SOURCE_FILES = ["Program.cs", "UpdateWindow.cs", "Guard.cs"].map(file => "launcher/" + file);
const OUTPUT_FILES = ["BTR_Desktop.exe", "BTR_Guard.exe"];
const COMMON_FLAGS = ["/nologo", "/optimize+", "/codepage:65001", "/reference:System.Web.Extensions.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const receiptPath = root => path.join(root, "release", "launcher-build.json");
const fileHashes = (root, files) => Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));

function verifyLaunchers(root = project) {
  const record = JSON.parse(fs.readFileSync(receiptPath(root), "utf8"));
  if (record.schema !== 1 || record.platform !== "win32" || JSON.stringify(record.flags) !== JSON.stringify(COMMON_FLAGS)
      || JSON.stringify(record.sources) !== JSON.stringify(fileHashes(root, SOURCE_FILES))
      || JSON.stringify(record.outputs) !== JSON.stringify(fileHashes(root, OUTPUT_FILES))) {
    throw Error("Windows launchers do not match this build; run tools/build-launcher.cjs on Windows again");
  }
  return record;
}

function buildLaunchers({ root = project, platform = process.platform, env = process.env, execute = spawnSync } = {}) {
  if (platform === "darwin") return { state: "skipped", platform, message: "macOS uses the native maintenance installer; no Windows executables were built" };
  if (platform !== "win32") throw Error("Launcher builds support Windows and macOS only");
  fs.rmSync(receiptPath(root), { force: true });
  const compiler = path.join(env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(compiler)) throw Error("Windows .NET Framework C# compiler was not found");
  const sources = SOURCE_FILES.map(file => path.join(root, file));
  const sourceHashes = fileHashes(root, SOURCE_FILES);
  // The guard uses the window subsystem, so signing in never flashes a console.
  for (const [target, output, extra] of [["exe", OUTPUT_FILES[0], []], ["winexe", OUTPUT_FILES[1], ["/define:GUARD"]]]) {
    const result = execute(compiler, [...COMMON_FLAGS, `/target:${target}`, ...extra, `/out:${path.join(root, output)}`, ...sources], { encoding: "utf8", windowsHide: true });
    process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
    if (result.error || result.status !== 0) throw Error(result.error?.message || `C# compiler failed (${result.status})`);
  }
  if (JSON.stringify(sourceHashes) !== JSON.stringify(fileHashes(root, SOURCE_FILES))) throw Error("Launcher source files changed during compilation");
  const record = { schema: 1, platform: "win32", flags: COMMON_FLAGS, sources: sourceHashes, outputs: fileHashes(root, OUTPUT_FILES) };
  fs.mkdirSync(path.dirname(receiptPath(root)), { recursive: true });
  fs.writeFileSync(receiptPath(root), JSON.stringify(record, null, 2) + "\n");
  return { state: "built", platform, files: OUTPUT_FILES };
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildLaunchers(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildLaunchers, verifyLaunchers, SOURCE_FILES, OUTPUT_FILES, COMMON_FLAGS, receiptPath };
