import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appAttestVerifier, decodeCbor, deviceBinding, deviceVerifiersFrom, judgeIntegrity, playIntegrityVerifier, runDeviceCheck } from "../../src/auth/deviceCheck.js";

/**
 * Contract v0.18.138 (contract.json#deviceCheck.check): the Android verdict rules, the Google decode call (fake fetch),
 * the App Attest checks against a test CA made here with openssl (never Apple's), and the server keys by name.
 */

const binding = deviceBinding("rider", "+46701752001", "install-000000000001");
const now = new Date("2026-11-20T10:00:00Z");
const good = () => ({
  requestDetails: { requestPackageName: "se.movera.rider", nonce: binding.toString("base64url"), timestampMillis: String(now.getTime() - 5000) },
  appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" },
  deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
});

describe("Play Integrity verdict (Android)", () => {
  it("passes only when package, nonce, age, app and device verdicts all hold", () => {
    const pkgs = ["se.movera.rider"];
    expect(judgeIntegrity(good(), pkgs, binding, now)).toEqual({ ok: true });
    expect(judgeIntegrity({ ...good(), requestDetails: { ...good().requestDetails, nonce: binding.toString("base64url") + "==" } }, pkgs, binding, now)).toEqual({ ok: true });
    expect(judgeIntegrity({ ...good(), requestDetails: { ...good().requestDetails, requestPackageName: "evil.app" } }, pkgs, binding, now)).toMatchObject({ ok: false, why: "package" });
    expect(judgeIntegrity({ ...good(), requestDetails: { ...good().requestDetails, nonce: Buffer.alloc(32).toString("base64url") } }, pkgs, binding, now)).toMatchObject({ why: "nonce" });
    expect(judgeIntegrity({ ...good(), requestDetails: { ...good().requestDetails, timestampMillis: String(now.getTime() - 601_000) } }, pkgs, binding, now)).toMatchObject({ why: "age" });
    expect(judgeIntegrity({ ...good(), requestDetails: { ...good().requestDetails, timestampMillis: String(now.getTime() + 120_000) } }, pkgs, binding, now)).toMatchObject({ why: "age" });
    expect(judgeIntegrity({ ...good(), appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } }, pkgs, binding, now)).toMatchObject({ why: "app_verdict" });
    expect(judgeIntegrity({ ...good(), deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } }, pkgs, binding, now)).toMatchObject({ why: "device_verdict" });
    expect(judgeIntegrity({}, pkgs, binding, now)).toMatchObject({ ok: false });
  });

  it("asks Google to decode the token with the service account's access token", async () => {
    const calls: Array<{ url: string; body?: string; auth?: string }> = [];
    const verifier = playIntegrityVerifier({
      tokens: { get: async () => "access-1" },
      packages: ["se.movera.rider"],
      clock: () => now,
      fetchFn: async (url, init) => {
        calls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.headers["authorization"] !== undefined ? { auth: init.headers["authorization"] } : {}) });
        return { status: 200, text: async () => JSON.stringify({ tokenPayloadExternal: good() }) };
      },
    });
    expect(await verifier.verify({ token: "tok", binding })).toEqual({ ok: true });
    expect(calls[0]).toEqual({ url: "https://playintegrity.googleapis.com/v1/se.movera.rider:decodeIntegrityToken", body: JSON.stringify({ integrity_token: "tok" }), auth: "Bearer access-1" });
    const refused = playIntegrityVerifier({ tokens: { get: async () => "a" }, packages: ["se.movera.rider"], clock: () => now, fetchFn: async () => ({ status: 400, text: async () => "{}" }) });
    expect(await refused.verify({ token: "tok", binding })).toMatchObject({ ok: false, why: "decode" });
  });

  it("no verifier for a platform (keys not set) is a failed check", async () => {
    expect(await runDeviceCheck({}, { platform: "android", token: "t" }, binding)).toEqual({ ok: false, why: "not_configured" });
    expect(await runDeviceCheck({}, { platform: "ios", token: "t", keyId: "k" }, binding)).toEqual({ ok: false, why: "not_configured" });
  });
});

describe("server keys (names only)", () => {
  it("no keys: no verifier and no warning; half the keys: no verifier and a warning naming only what is missing", () => {
    expect(deviceVerifiersFrom({ MOVERA_ENV: "production" } as never)).toEqual({ verifiers: {}, warnings: [] });
    const half = deviceVerifiersFrom({ MOVERA_ENV: "production", PLAY_INTEGRITY_PACKAGES: "se.movera.rider", APPLE_APP_ATTEST_APP_IDS: "TEAM.se.movera.rider" } as never);
    expect(half.verifiers).toEqual({});
    expect(half.warnings).toEqual(["Play Integrity is off: PLAY_INTEGRITY_SERVICE_ACCOUNT not_set, PLAY_INTEGRITY_PACKAGES ok", "App Attest is off: APPLE_APP_ATTEST_APP_IDS ok, APPLE_APP_ATTEST_ROOT_CA not_set"]);
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const full = deviceVerifiersFrom({ MOVERA_ENV: "production", PLAY_INTEGRITY_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p", client_email: "e@p", private_key: key }), PLAY_INTEGRITY_PACKAGES: "se.movera.rider, se.movera.driver" } as never);
    expect(Object.keys(full.verifiers)).toEqual(["android"]);
    expect(full.warnings.join(" ")).not.toContain(key.slice(40, 80));
  });
});

/* ---------------------------------------------------------------- App Attest with a test CA (openssl) */

/** A small CBOR writer for the test attestation (maps with text keys, byte strings, arrays). */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]));
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = Object.entries(value as Record<string, unknown>);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}
const sha = (...parts: Buffer[]) => parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();

let dir: string;
let rootPem: string;
let otherRootPem: string;
const APP_ID = "TEAMID1234.se.movera.rider";

function ossl(args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "attest-"));
  const ca = (name: string) => {
    ossl(["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", `${name}.key`]);
    ossl(["req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-days", "5", "-out", `${name}.pem`, "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign"]);
  };
  ca("root");
  ca("other");
  ossl(["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", "mid.key"]);
  ossl(["req", "-new", "-key", "mid.key", "-subj", "/CN=mid", "-out", "mid.csr"]);
  writeFileSync(join(dir, "mid.ext"), "basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n");
  ossl(["x509", "-req", "-in", "mid.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "4", "-extfile", "mid.ext", "-out", "mid.pem"]);
  ossl(["x509", "-in", "mid.pem", "-outform", "DER", "-out", "mid.der"]);
  rootPem = readFileSync(join(dir, "root.pem"), "utf8");
  otherRootPem = readFileSync(join(dir, "other.pem"), "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A whole attestation for `binding`; `bend` changes one part to test each rule. */
function attestation(bend: { appId?: string; counter?: number; aaguid?: string; nonceFor?: Buffer; credId?: Buffer } = {}, name = "leaf") {
  // authData holds the key id (the hash of the leaf's key), so the key comes first, then the leaf with the nonce.
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
  ossl(["ec", "-in", `${name}.key`, "-pubout", "-outform", "DER", "-out", `${name}.pub`]);
  const pub = readFileSync(join(dir, `${name}.pub`));
  const keyId = sha(pub.subarray(pub.length - 65));
  const cred = bend.credId ?? keyId;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(bend.counter ?? 0);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(cred.length);
  const authData = Buffer.concat([sha(Buffer.from(bend.appId ?? APP_ID)), Buffer.from([0x40]), counter, Buffer.from(bend.aaguid ?? "appattest\0\0\0\0\0\0\0", "latin1"), len, cred, Buffer.from([0xa0])]);
  const nonce = sha(authData, bend.nonceFor ?? binding);
  ossl(["req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`]);
  writeFileSync(join(dir, `${name}.ext`), `1.2.840.113635.100.8.2=DER:3024a1220420${nonce.toString("hex")}\n`);
  ossl(["x509", "-req", "-in", `${name}.csr`, "-CA", "mid.pem", "-CAkey", "mid.key", "-CAcreateserial", "-days", "3", "-extfile", `${name}.ext`, "-out", `${name}.pem`]);
  ossl(["x509", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`]);
  const token = cbor({ fmt: "apple-appattest", attStmt: { x5c: [readFileSync(join(dir, `${name}.der`)), readFileSync(join(dir, "mid.der"))], receipt: Buffer.from("r") }, authData }).toString("base64");
  return { token, keyId: keyId.toString("base64") };
}

describe("App Attest (iPhone; inactive on the live server until the owner's Apple keys exist)", () => {
  it("passes a right attestation and refuses each broken part", async () => {
    const verifier = appAttestVerifier({ appIds: [APP_ID], rootPem, production: true });
    const ok = attestation();
    expect(await verifier.verify({ ...ok, binding })).toEqual({ ok: true });
    expect(await verifier.verify({ ...ok, binding: deviceBinding("rider", "+46701752002", "install-000000000001") })).toMatchObject({ ok: false, why: "nonce" });
    expect(await verifier.verify({ token: ok.token, keyId: Buffer.alloc(32, 1).toString("base64"), binding })).toMatchObject({ why: "key_id" });
    expect(await verifier.verify({ token: ok.token, binding })).toMatchObject({ why: "key_id" });
    expect(await verifier.verify({ ...attestation({ appId: "TEAMID1234.evil.app" }), binding })).toMatchObject({ why: "app_id" });
    expect(await verifier.verify({ ...attestation({ counter: 1 }), binding })).toMatchObject({ why: "counter" });
    expect(await verifier.verify({ ...attestation({ aaguid: "appattestdevelop" }), binding })).toMatchObject({ why: "aaguid" });
    expect(await verifier.verify({ ...attestation({ credId: Buffer.alloc(32, 7) }), binding })).toMatchObject({ why: "credential" });
    expect(await verifier.verify({ token: "bm90IGNib3I=", keyId: ok.keyId, binding })).toMatchObject({ why: "shape" });
    const stranger = appAttestVerifier({ appIds: [APP_ID], rootPem: otherRootPem, production: true });
    expect(await stranger.verify({ ...ok, binding })).toMatchObject({ why: "chain" });
    const later = appAttestVerifier({ appIds: [APP_ID], rootPem, production: true, clock: () => new Date(Date.now() + 30 * 86_400_000) });
    expect(await later.verify({ ...ok, binding })).toMatchObject({ why: "chain" });
  }, 30_000);

  it("takes the development aaguid outside production only", async () => {
    const dev = attestation({ aaguid: "appattestdevelop" }, "dev");
    expect(await appAttestVerifier({ appIds: [APP_ID], rootPem, production: false }).verify({ ...dev, binding })).toEqual({ ok: true });
  }, 30_000);

  it("the CBOR reader refuses trailing bytes, deep nesting and unknown types", () => {
    expect(decodeCbor(cbor({ a: [Buffer.from("x"), "y"] })) instanceof Map).toBe(true);
    expect(() => decodeCbor(Buffer.concat([cbor("a"), Buffer.from([0])]))).toThrow();
    expect(() => decodeCbor(Buffer.from(new Array(40).fill(0x81).concat([0])))).toThrow();
    expect(() => decodeCbor(Buffer.from([0xc0, 0]))).toThrow();
  });
});
