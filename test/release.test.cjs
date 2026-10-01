"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { buildLaunchers, verifyLaunchers, SOURCE_FILES, OUTPUT_FILES, receiptPath } = require("../tools/build-launcher.cjs");
const { packageRelease, manifestFor, platformsFor, filesForRelease, createArchive, COMMON_FILES } = require("../tools/package-release.cjs");
const { sha } = require("../tools/asar.cjs");
const config = { version: "2026.9.29.1-d2", legacyClientVersions: ["1.18.0"] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "btr-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [...COMMON_FILES, ...SOURCE_FILES, ...OUTPUT_FILES, "docs/verification.md", "docs/images/settings.png"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "fixture: " + file);
  }
  fs.writeFileSync(path.join(root, "desktop.json"), JSON.stringify(config));
  const windir = path.join(root, "Windows"), compiler = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  fs.mkdirSync(path.dirname(compiler), { recursive: true }); fs.writeFileSync(compiler, "fixture compiler");
  return { root, env: { ...process.env, WINDIR: windir } };
}
function compileFixture(options) {
  return buildLaunchers({ ...options, platform: "win32", execute: (_command, args) => {
    const output = args.find(value => value.startsWith("/out:")).slice(5);
    fs.writeFileSync(output, "compiled " + path.basename(output));
    return { status: 0, stdout: "", stderr: "" };
  } });
}

test("macOS skips Windows compilation and never packages existing executables", t => {
  const { root } = fixture(t);
  assert.equal(buildLaunchers({ root, platform: "darwin", execute: () => assert.fail("compiler must not run") }).state, "skipped");
  const files = filesForRelease(root, "darwin");
  assert.ok(files.includes("install.sh")); assert.ok(files.includes("macos/installer.cjs")); assert.ok(files.includes("tools/client-path.cjs"));
  for (const file of OUTPUT_FILES) assert.ok(!files.includes(file));
  assert.deepEqual(platformsFor("darwin"), ["darwin"]);
  assert.throws(() => platformsFor("linux"), /Windows and macOS/);
});

test("Windows packaging requires a successful build of both current launchers", t => {
  const f = fixture(t);
  assert.throws(() => packageRelease({ ...f, platform: "win32" }), /ENOENT/);
  assert.equal(compileFixture(f).state, "built");
  assert.equal(verifyLaunchers(f.root).platform, "win32");
  assert.deepEqual(platformsFor("win32"), ["win32", "darwin"]);
  fs.appendFileSync(path.join(f.root, SOURCE_FILES[0]), "changed source");
  assert.throws(() => verifyLaunchers(f.root), /do not match/);
  compileFixture(f);
  fs.appendFileSync(path.join(f.root, OUTPUT_FILES[0]), "changed output");
  assert.throws(() => verifyLaunchers(f.root), /do not match/);
  assert.throws(() => buildLaunchers({ ...f, platform: "win32", execute: () => ({ status: 1 }) }), /compiler failed/);
  assert.equal(fs.existsSync(receiptPath(f.root)), false, "a failed rebuild invalidates its receipt");
});

test("release manifests retain legacy fields and explicitly declare supported platforms", () => {
  const bytes = Buffer.from("release payload"), manifest = manifestFor(config, bytes, "darwin");
  assert.equal(manifest.schema, 1); assert.equal(manifest.version, config.version);
  assert.equal(manifest.sha256, sha(bytes)); assert.deepEqual(manifest.supportedClientVersions, ["1.18.0"]);
  assert.deepEqual(manifest.platforms, ["darwin"]); assert.ok(manifest.downloadUrl.endsWith(`/packages/BTR_Desktop-${config.version}.zip`));
  assert.throws(() => manifestFor({ version: "../unsafe" }, bytes, "darwin"), /Invalid desktop version/);
});

test("Windows archive creation falls back to PowerShell without interpolating paths", t => {
  const { root, env } = fixture(t), directory = path.join(root, "a '$ checkout", "BTR_Desktop"), archive = path.join(root, "package.zip"), calls = [];
  const tool = createArchive({ platform: "win32", staging: path.dirname(directory), directory, archive, env, execute: (command, args, options) => {
    calls.push({ command, args, options });
    return command.endsWith("powershell.exe") ? { status: 0 } : { status: null, error: Error("7zip unavailable") };
  } });
  assert.equal(tool, "powershell"); assert.equal(calls.length, 3);
  const fallback = calls.at(-1);
  assert.equal(fallback.options.env.BTR_PACKAGE_SOURCE, directory); assert.equal(fallback.options.env.BTR_PACKAGE_ARCHIVE, archive);
  assert.ok(fallback.args.includes("-NonInteractive")); assert.ok(!fallback.args.at(-1).includes(directory));
  assert.match(fallback.args.at(-1), /Compress-Archive -LiteralPath/);
});

test("package staging includes maintenance dependencies and removes temporary files after failure", t => {
  const f = fixture(t), seen = [];
  const report = packageRelease({ ...f, platform: "darwin", execute: (command, args) => {
    assert.equal(command, "/usr/bin/ditto"); assert.ok(args.includes("--keepParent"));
    const directory = args.at(-2);
    for (const file of filesForRelease(f.root, "darwin")) { assert.ok(fs.existsSync(path.join(directory, file))); seen.push(file); }
    for (const file of OUTPUT_FILES) assert.equal(fs.existsSync(path.join(directory, file)), false);
    fs.writeFileSync(args.at(-1), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]));
    return { status: 0 };
  } });
  assert.equal(report.files, seen.length); assert.equal(report.archiveTool, "ditto");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "latest.json"))).platforms, ["darwin"]);
  const before = fs.readFileSync(path.join(f.root, "latest.json"));
  assert.throws(() => packageRelease({ ...f, platform: "darwin", execute: () => ({ status: 1, stderr: "archive failed" }) }), /archive failed/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, "latest.json")), before);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith("release-stage-")), []);
});

test("native macOS ZIP contains a single package root and the complete Darwin resources", { skip: process.platform !== "darwin" }, t => {
  const f = fixture(t), report = packageRelease({ ...f, platform: "darwin" });
  const listing = spawnSync("/usr/bin/unzip", ["-Z1", report.archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const names = listing.stdout.trim().split(/\r?\n/);
  for (const file of filesForRelease(f.root, "darwin")) assert.ok(names.includes("BTR_Desktop/" + file), "ZIP omitted " + file);
  assert.ok(names.every(name => name.startsWith("BTR_Desktop/")), "ZIP has entries outside its package root");
  assert.ok(!names.some(name => name.endsWith(".exe")));
  assert.equal(report.sha256, sha(fs.readFileSync(report.archive)));
});
