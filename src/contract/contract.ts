import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The shared contract this server implements: contracts/ is a byte-for-byte copy of movera-contracts at a tag
 * (tools/sync_contract.sh), checked against contracts/CHECKSUMS by test/contract_copy.test.ts.
 */
export const CONTRACTS_DIR = fileURLToPath(new URL("../../contracts/", import.meta.url));

export function contractFile(path: string): string {
  return readFileSync(new URL(`../../contracts/${path}`, import.meta.url), "utf8");
}

export function contractJson<T = unknown>(path: string): T {
  return JSON.parse(contractFile(path)) as T;
}

type ContractHead = {
  version: string;
  headers: Record<string, string>;
  errors: { codes: string[] };
};

export const contract = contractJson<ContractHead & Record<string, unknown>>("contract.json");

/** e.g. "0.5.0" */
export const CONTRACT_VERSION: string = contract.version;
/** The X-Api-Version every request may send and every response carries, e.g. "0.5". */
export const API_VERSION: string = contract.headers["X-Api-Version"] ?? CONTRACT_VERSION.split(".").slice(0, 2).join(".");
export const ERROR_CODES: readonly string[] = contract.errors.codes;
