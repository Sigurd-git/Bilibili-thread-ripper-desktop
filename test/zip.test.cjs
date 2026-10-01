"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const { crc32, readZip, extractZip } = require("../tools/zip.cjs");

function makeZip(entries) {
  const localParts = [], centralParts = [];
  let localOffset = 0, centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8"), body = Buffer.from(entry.body || "");
    const method = entry.method || 0, packed = method === 8 ? zlib.deflateRawSync(body) : body;
    const checksum = crc32(body), localCrc = entry.localCrc ?? checksum, centralCrc = entry.centralCrc ?? checksum;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(localCrc, 14); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    localParts.push(local, packed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(centralCrc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(localOffset, 42); name.copy(central, 46);
    centralParts.push(central); centralSize += central.length; localOffset += local.length + packed.length;
  }
  const count = entries.length, end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function withDestination(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "btr-zip-test-")), destination = path.join(temporary, "destination");
  try { run(destination, temporary); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test("reads and extracts a standard ZIP with complete file contents", () => {
  const zip = makeZip([
    { name: "BTR_Desktop/", body: "", mode: 0o040755 },
    { name: "BTR_Desktop/README.txt", body: "release readme\n" },
    { name: "BTR_Desktop/dist/desktop.js", body: "window.btr = true;\n", method: 8 },
    { name: "BTR_Desktop/bin/client.dat", body: Buffer.from([0, 1, 127, 255]) }
  ]);
  const files = readZip(zip);
  assert.deepEqual(files.filter(file => !file.directory).map(file => [file.name, Buffer.from(file.body)]), [
    ["BTR_Desktop/README.txt", Buffer.from("release readme\n")],
    ["BTR_Desktop/dist/desktop.js", Buffer.from("window.btr = true;\n")],
    ["BTR_Desktop/bin/client.dat", Buffer.from([0, 1, 127, 255])]
  ]);
  withDestination(destination => {
    const root = extractZip(zip, destination);
    assert.equal(root, path.join(destination, "BTR_Desktop"));
    assert.equal(fs.readFileSync(path.join(root, "README.txt"), "utf8"), "release readme\n");
    assert.equal(fs.readFileSync(path.join(root, "dist/desktop.js"), "utf8"), "window.btr = true;\n");
    assert.deepEqual(fs.readFileSync(path.join(root, "bin/client.dat")), Buffer.from([0, 1, 127, 255]));
  });
});

function rejectsWithoutWriting(zip, pattern, outsideName) {
  withDestination((destination, temporary) => {
    assert.throws(() => extractZip(zip, destination), pattern);
    assert.equal(fs.existsSync(destination), false, "validation failure must happen before destination creation");
    if (outsideName) assert.equal(fs.existsSync(path.join(temporary, outsideName)), false, "archive must not write outside destination");
  });
}

test("rejects a CRC mismatch before writing the destination", () => {
  const zip = makeZip([{ name: "BTR_Desktop/readme.txt", body: "verified bytes", centralCrc: 1 }]);
  assert.throws(() => readZip(zip), /checksum/i);
  rejectsWithoutWriting(zip, /checksum/i);
});

test("rejects duplicate paths before writing the destination", () => {
  const zip = makeZip([
    { name: "BTR_Desktop/data.txt", body: "first" },
    { name: "BTR_Desktop/DATA.TXT", body: "second" }
  ]);
  assert.throws(() => readZip(zip), /unsafe package entry/i);
  rejectsWithoutWriting(zip, /unsafe package entry/i);
});

test("rejects path traversal before writing the destination", () => {
  const zip = makeZip([{ name: "BTR_Desktop/../escaped.txt", body: "outside" }]);
  assert.throws(() => readZip(zip), /unsafe package entry/i);
  rejectsWithoutWriting(zip, /unsafe package entry/i, "escaped.txt");
});

test("rejects symbolic links before writing the destination", () => {
  const zip = makeZip([{ name: "BTR_Desktop/link", body: "target", mode: 0o120777 }]);
  assert.throws(() => readZip(zip), /unsupported ZIP entry/i);
  rejectsWithoutWriting(zip, /unsupported ZIP entry/i);
});

test("rejects archives whose expanded size exceeds the limit before writing the destination", () => {
  const body = Buffer.alloc(24 * 1024 * 1024 + 1, 65);
  const zip = makeZip([{ name: "BTR_Desktop/large.txt", body, method: 8 }]);
  assert.ok(zip.length < 24 * 1024 * 1024, "fixture stays below the compressed archive limit");
  assert.throws(() => readZip(zip), /expanded package exceeds size limit/i);
  rejectsWithoutWriting(zip, /expanded package exceeds size limit/i);
});

test("rejects file and directory path conflicts before writing the destination", () => {
  const zip = makeZip([
    { name: "BTR_Desktop/assets", body: "file" },
    { name: "BTR_Desktop/assets/logo.png", body: "child" }
  ]);
  assert.throws(() => readZip(zip), /file\/directory conflict/i);
  rejectsWithoutWriting(zip, /file\/directory conflict/i);
});
