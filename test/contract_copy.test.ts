import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { API_VERSION, CONTRACTS_DIR, CONTRACT_VERSION, contractFile } from "../src/contract/contract.js";

/** contracts/ is a byte-for-byte copy of movera-contracts (tools/sync_contract.sh). Never edit it here. */
describe("contracts/", () => {
  it("matches contracts/CHECKSUMS, file for file", () => {
    const listed = new Map(
      contractFile("CHECKSUMS")
        .trim()
        .split("\n")
        .map((line) => {
          const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
          expect(match, `bad CHECKSUMS line: ${line}`).not.toBeNull();
          return [match![2]!, match![1]!] as const;
        }),
    );
    const onDisk: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "__pycache__") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (relative(CONTRACTS_DIR, path) !== "CHECKSUMS") onDisk.push(relative(CONTRACTS_DIR, path).split("\\").join("/"));
      }
    };
    walk(CONTRACTS_DIR);
    expect(onDisk.sort()).toEqual([...listed.keys()].sort());
    for (const [path, sha] of listed) {
      const actual = createHash("sha256").update(readFileSync(join(CONTRACTS_DIR, path))).digest("hex");
      expect(actual, `${path} drifted from CHECKSUMS`).toBe(sha);
    }
  });

  it("is contract v0.9.0, API 0.5", () => {
    expect(CONTRACT_VERSION).toBe("0.9.0");
    expect(API_VERSION).toBe("0.5");
  });
});
