"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { sha } = require("./asar.cjs"), { RAW, VERSION } = require("./update-provider.cjs");
const { verifyLaunchers, OUTPUT_FILES } = require("./build-launcher.cjs");
const project = path.resolve(__dirname, "..");
const COMMON_FILES = ["desktop.json", "install.ps1", "force-update.ps1", "install.sh", "macos/installer.cjs", "README.md", "difference.md", "LICENSE", "dist/desktop.js", "dist/payload.json", "src/bootstrap.cjs", "src/update-main.cjs", "tools/asar.cjs", "tools/client-package.cjs", "tools/client-path.cjs", "tools/update-provider.cjs", "tools/https-json.cjs", "tools/zip.cjs"];

function platformsFor(platform) {
  if (platform === "win32") return ["win32", "darwin"];
  if (platform === "darwin") return ["darwin"];
  throw Error("Release packaging supports Windows and macOS only");
}

function filesForRelease(root, platform) {
  platformsFor(platform);
  const files = [...COMMON_FILES, ...(platform === "win32" ? OUTPUT_FILES : [])];
  function collect(relative) {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error("Release resources must not be symbolic links: " + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) collect(relative + "/" + name);
    } else if (stat.isFile()) files.push(relative);
    else throw Error("Unsupported release resource: " + relative);
  }
  collect("docs");
  for (const file of files) if (!fs.lstatSync(path.join(root, file)).isFile() || fs.lstatSync(path.join(root, file)).isSymbolicLink()) throw Error("Missing or unsafe release resource: " + file);
  return files.sort();
}

function createArchive({ platform, staging, directory, archive, execute = spawnSync, env = process.env }) {
  if (platform === "darwin") {
    const result = execute("/usr/bin/ditto", ["-c", "-k", "--keepParent", directory, archive], { encoding: "utf8", env });
    if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || "ditto ZIP creation failed");
    return "ditto";
  }
  platformsFor(platform);
  const candidates = [...new Set([path.join(env.ProgramFiles || "C:/Program Files", "7-Zip", "7z.exe"), "7z.exe"])];
  for (const command of candidates) {
    const result = execute(command, ["a", "-tzip", archive, path.basename(directory)], { cwd: staging, windowsHide: true, encoding: "utf8", env });
    if (!result.error && result.status === 0) return "7zip";
    fs.rmSync(archive, { force: true });
  }
  // Environment arguments avoid interpolating checkout paths into PowerShell source.
  const powershell = path.join(env.WINDIR || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:BTR_PACKAGE_SOURCE -DestinationPath $env:BTR_PACKAGE_ARCHIVE -CompressionLevel Optimal -Force";
  const result = execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, encoding: "utf8", env: { ...env, BTR_PACKAGE_SOURCE: directory, BTR_PACKAGE_ARCHIVE: archive } });
  if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || "PowerShell ZIP creation failed");
  return "powershell";
}

function manifestFor(config, bytes, platform) {
  if (!VERSION.test(config.version)) throw Error("Invalid desktop version");
  return { schema: 1, version: config.version, downloadUrl: RAW + `packages/BTR_Desktop-${config.version}.zip`, sha256: sha(bytes), supportedClientVersions: config.legacyClientVersions, platforms: platformsFor(platform) };
}

function packageRelease({ root = project, platform = process.platform, execute = spawnSync, env = process.env } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "desktop.json"), "utf8"));
  if (!VERSION.test(config.version)) throw Error("Invalid desktop version");
  if (platform === "win32") verifyLaunchers(root);
  const files = filesForRelease(root, platform);
  const staging = fs.mkdtempSync(path.join(root, "release-stage-")), directory = path.join(staging, "BTR_Desktop");
  try {
    for (const file of files) {
      const destination = path.join(directory, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, file), destination);
    }
    const temporary = path.join(staging, "package.zip");
    const archiveTool = createArchive({ platform, staging, directory, archive: temporary, execute, env });
    const bytes = fs.readFileSync(temporary);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw Error("Archive tool did not create a ZIP package");
    const manifest = manifestFor(config, bytes, platform), packages = path.join(root, "packages");
    fs.mkdirSync(packages, { recursive: true });
    const archive = path.join(packages, `BTR_Desktop-${config.version}.zip`);
    fs.writeFileSync(archive, bytes);
    fs.writeFileSync(path.join(root, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { archive, files: files.length, archiveTool, ...manifest };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { console.log(JSON.stringify(packageRelease(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageRelease, manifestFor, platformsFor, filesForRelease, createArchive, COMMON_FILES };
