#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const PROJECT = __dirname;
const BUILD = path.join(PROJECT, "build");
const HOME = path.join(os.homedir(), ".apkbuild");
const isWindows = process.platform === "win32";
const exeExtensions = isWindows ? [".exe", ".bat", ".cmd", ""] : [""];

const installHints =
  "  Arch: pacman -S jdk-openjdk android-sdk-build-tools android-platform\n" +
  "  Else: install a JDK, set ANDROID_HOME, then\n" +
  "        sdkmanager 'build-tools;36.0.0' 'platforms;android-36'";

function fail(message) {
  console.error("\napkbuild: " + message + "\n");
  process.exit(1);
}

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(base) {
  return exeExtensions.map((extension) => base + extension).find(exists) || null;
}

function newestSubdir(root) {
  const numbers = (name) => (name.match(/\d+/g) || []).map(Number);
  const compare = (a, b) => {
    const [left, right] = [numbers(a), numbers(b)];
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const difference = (left[index] || 0) - (right[index] || 0);
      if (difference) return difference;
    }
    return 0;
  };
  return exists(root) ? fs.readdirSync(root).sort(compare).reverse() : [];
}

function findJavaTool(name) {
  const roots = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin"),
    ...(process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);
  return roots.map((dir) => resolveExecutable(path.join(dir, name))).find(Boolean) || null;
}

function findSdkRoot() {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "Library", "Android", "sdk"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    "/opt/android-sdk",
    "/usr/lib/android-sdk",
  ].filter(Boolean).find((root) => exists(path.join(root, "build-tools")));
}

function locateTools() {
  const javac = findJavaTool("javac");
  const keytool = findJavaTool("keytool");
  if (!javac || !keytool) fail("JDK not found (javac + keytool):\n" + installHints);

  const sdk = findSdkRoot();
  if (!sdk) fail("Android SDK not found. Set ANDROID_HOME:\n" + installHints);

  const buildTools = newestSubdir(path.join(sdk, "build-tools"))
    .map((version) => path.join(sdk, "build-tools", version))
    .find((dir) => resolveExecutable(path.join(dir, "aapt2")));
  if (!buildTools) fail("No build-tools in " + sdk + ":\n" + installHints);

  const platform = newestSubdir(path.join(sdk, "platforms"))
    .map((name) => path.join(sdk, "platforms", name, "android.jar"))
    .find(exists);
  if (!platform) fail("No platform android.jar in " + sdk + ":\n" + installHints);

  const tool = (name) => {
    const found = resolveExecutable(path.join(buildTools, name));
    if (!found) fail(name + " missing in " + buildTools);
    return found;
  };

  return {
    javac, keytool,
    aapt2: tool("aapt2"), d8: tool("d8"),
    zipalign: tool("zipalign"), apksigner: tool("apksigner"),
    dexdump: resolveExecutable(path.join(buildTools, "dexdump")),
    androidJar: platform,
    platformApi: Number((platform.match(/android-(\d+)/) || [0, 0])[1]),
  };
}

function run(label, executable, args) {
  const useShell = isWindows && /\.(bat|cmd)$/i.test(executable);
  const quoted = `"${executable}" ${args.map((arg) => `"${arg}"`).join(" ")}`;
  const result = spawnSync(useShell ? quoted : executable, useShell ? [] : args, {
    encoding: "utf8", shell: useShell, maxBuffer: 1 << 28,
  });
  if (result.error) fail(label + ": " + result.error.message);
  if (result.status !== 0) fail(label + " failed:\n" + (result.stderr || result.stdout));
  return result.stdout;
}

function collectFiles(root, extension) {
  if (!exists(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

function readManifest(manifest, platformApi) {
  const text = fs.readFileSync(manifest, "utf8");
  const value = (attribute) => (text.match(new RegExp(attribute + '\\s*=\\s*"([\\w.]+)"')) || [])[1];
  const packageName = value("package");
  if (!packageName) fail('No package="..." in ' + manifest);
  return {
    packageName,
    versionName: value("versionName") || "1.0",
    minSdk: Number(value("minSdkVersion") || 24),
    targetSdk: Number(value("targetSdkVersion") || platformApi),
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Append one deflated entry to a ZIP buffer (End Of Central Directory at tail). */
function appendZipEntry(zip, name, data) {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);

  const nameBytes = Buffer.from(name);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const checksum = crc32(data);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0x21, 12);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0x21, 14);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt32LE(centralOffset, 42);

  const localEntry = Buffer.concat([localHeader, nameBytes, compressed]);
  const eocdRecord = Buffer.alloc(22);
  eocdRecord.writeUInt32LE(0x06054b50, 0);
  eocdRecord.writeUInt16LE(count + 1, 8);
  eocdRecord.writeUInt16LE(count + 1, 10);
  eocdRecord.writeUInt32LE(centralSize + centralHeader.length + nameBytes.length, 12);
  eocdRecord.writeUInt32LE(centralOffset + localEntry.length, 16);

  return Buffer.concat([
    zip.subarray(0, centralOffset), localEntry,
    zip.subarray(centralOffset, centralOffset + centralSize),
    centralHeader, nameBytes, eocdRecord,
  ]);
}

/**
 * A release key at ~/.apkbuild/keys/<package>.jks, with its password in a
 * sibling .pass file, is used automatically. Everything else falls back to a
 * shared throwaway debug key.
 */
function resolveSigningKey(keytool, packageName) {
  const keystore = path.join(HOME, "keys", packageName + ".jks");
  const passwordFile = path.join(HOME, "keys", packageName + ".pass");
  if (exists(keystore)) {
    if (!exists(passwordFile)) fail("Release key has no matching " + passwordFile);
    return { keystore, alias: "app", password: "file:" + passwordFile, release: true };
  }

  const debug = path.join(HOME, "debug.keystore");
  if (!exists(debug)) {
    fs.mkdirSync(HOME, { recursive: true });
    run("keytool", keytool, [
      "-genkeypair", "-keystore", debug, "-storepass", "android",
      "-keypass", "android", "-alias", "debug", "-keyalg", "RSA",
      "-keysize", "2048", "-validity", "10000", "-dname", "CN=Debug,O=apkbuild,C=US",
    ]);
  }
  return { keystore: debug, alias: "debug", password: "pass:android", release: false };
}

function packageResources(tools, levels, manifest) {
  const baseApk = path.join(BUILD, "base.apk");
  const linkArgs = [
    "link", "-I", tools.androidJar, "--manifest", manifest,
    "--min-sdk-version", String(levels.minSdk),
    "--target-sdk-version", String(levels.targetSdk), "-o", baseApk,
  ];

  const resDir = path.join(PROJECT, "res");
  if (!exists(resDir)) {
    run("aapt2 link", tools.aapt2, linkArgs);
    return { baseApk, generated: [] };
  }

  const compiled = path.join(BUILD, "res.zip");
  const genDir = path.join(BUILD, "gen");
  run("aapt2 compile", tools.aapt2, ["compile", "--dir", resDir, "-o", compiled]);
  fs.mkdirSync(genDir, { recursive: true });
  run("aapt2 link", tools.aapt2, [...linkArgs, compiled, "--java", genDir]);
  return { baseApk, generated: collectFiles(genDir, ".java") };
}

function dexReferences(dexdump, dex) {
  const pattern = /L((?:android|java|javax|org\/(?:json|xml))[\w/$]*);\.([\w<>$]+:\(\S*\)\S+)/g;
  const references = new Map();
  for (const [, owner, member] of run("dexdump", dexdump, ["-d", dex]).matchAll(pattern)) {
    references.set(owner + "." + member, { owner, member: member.replace(":", "") });
  }
  return [...references.values()];
}

function loadApiLevels(file, wantedClasses) {
  const levels = new Map();
  for (const block of fs.readFileSync(file, "utf8").split("<class ")) {
    const header = block.slice(0, block.indexOf(">"));
    const name = (header.match(/name="([^"]+)"/) || [])[1];
    if (!name || !wantedClasses.has(name)) continue;

    const classSince = Number((header.match(/since="(\d+)"/) || [])[1] || 1);
    levels.set(name, classSince);
    for (const [, member, since] of block.matchAll(/<method name="([^"]+)"(?: since="(\d+)")?/g)) {
      levels.set(name + "." + member, Number(since || classSince));
    }
  }
  return levels;
}

/**
 * javac compiles against the newest android.jar, so an API newer than
 * minSdkVersion builds and dexes cleanly, then crashes on older devices.
 * Verify the finished dex against the SDK's own API table.
 */
function auditApiLevels(tools, dex, minSdk) {
  const table = path.join(path.dirname(tools.androidJar), "data", "api-versions.xml");
  if (!tools.dexdump || !exists(table)) return;

  const references = dexReferences(tools.dexdump, dex);
  const levels = loadApiLevels(table, new Set(references.map((entry) => entry.owner)));
  const tooNew = references
    .map((entry) => ({ ...entry, since: levels.get(entry.owner + "." + entry.member) }))
    .filter((entry) => entry.since > minSdk)
    .sort((a, b) => b.since - a.since);
  if (!tooNew.length) return;

  fail(
    `${tooNew.length} API(s) newer than minSdkVersion ${minSdk}.\n` +
    "These compile and dex cleanly but throw NoSuchMethodError on older devices:\n\n" +
    tooNew.map((e) => `  API ${e.since}: ${e.owner}.${e.member}`).join("\n") +
    "\n\nRaise minSdkVersion, or guard each call with Build.VERSION.SDK_INT."
  );
}

function main() {
  const manifest = path.join(PROJECT, "AndroidManifest.xml");
  if (!exists(manifest)) fail("AndroidManifest.xml not found in " + PROJECT);

  const sources = collectFiles(path.join(PROJECT, "src"), ".java");
  if (!sources.length) fail("No .java files under src/ in " + PROJECT);

  const tools = locateTools();
  const levels = readManifest(manifest, tools.platformApi);
  fs.rmSync(BUILD, { recursive: true, force: true });
  const classesDir = path.join(BUILD, "classes");
  fs.mkdirSync(classesDir, { recursive: true });

  console.log("packaging resources...");
  const { baseApk, generated } = packageResources(tools, levels, manifest);

  console.log("compiling " + (sources.length + generated.length) + " source(s)...");
  run("javac", tools.javac, [
    "-g:none", "-classpath", tools.androidJar, "-d", classesDir, ...sources, ...generated,
  ]);

  console.log("dexing...");
  run("d8", tools.d8, [
    "--release", "--min-api", String(levels.minSdk),
    "--lib", tools.androidJar, "--output", BUILD, ...collectFiles(classesDir, ".class"),
  ]);

  console.log("checking API levels...");
  const dex = path.join(BUILD, "classes.dex");
  auditApiLevels(tools, dex, levels.minSdk);

  const unsigned = path.join(BUILD, "unsigned.apk");
  const base = fs.readFileSync(baseApk);
  fs.writeFileSync(unsigned, appendZipEntry(base, "classes.dex", fs.readFileSync(dex)));

  console.log("aligning...");
  const aligned = path.join(BUILD, "aligned.apk");
  run("zipalign", tools.zipalign, ["-f", "4", unsigned, aligned]);

  const key = resolveSigningKey(tools.keytool, levels.packageName);
  console.log(key.release ? "signing with release key..." : "signing with debug key...");
  const apk = path.join(BUILD, `${path.basename(PROJECT)}-${levels.versionName}.apk`);
  const signArgs = [
    "sign", "--ks", key.keystore, "--ks-pass", key.password,
    "--ks-key-alias", key.alias, "--v4-signing-enabled", "false",
  ];
  if (levels.minSdk >= 24) signArgs.push("--v1-signing-enabled", "false");
  run("apksigner", tools.apksigner, [...signArgs, "--out", apk, aligned]);

  console.log("\ndone: " + apk + " (" + fs.statSync(apk).size + " bytes)");
}

main();
