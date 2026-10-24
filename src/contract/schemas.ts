import { readFileSync } from "node:fs";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { CONTRACTS_DIR } from "./contract.js";

/**
 * JSON Schema checks straight from contracts/openapi.yaml, so a document the server accepts is exactly one the
 * contract allows. Compiled once per schema name, on first use.
 */
const openapi = parse(readFileSync(`${CONTRACTS_DIR}/openapi.yaml`, "utf8")) as { components: { schemas: Record<string, unknown> } };
const ajv = new Ajv2020.default({ strict: false, allErrors: false });
addFormats.default(ajv);
ajv.addSchema({ $id: "movera", components: { schemas: openapi.components.schemas } });

const cache = new Map<string, ValidateFunction>();

export function schemaValidator(name: string): ValidateFunction {
  let validate = cache.get(name);
  if (validate === undefined) {
    if (!(name in openapi.components.schemas)) throw new Error(`No schema ${name} in openapi.yaml`);
    validate = ajv.getSchema(`movera#/components/schemas/${name}`)!;
    cache.set(name, validate);
  }
  return validate;
}

/** The first problem as a short sentence (field path + message), or null when the value is valid. */
export function schemaProblem(name: string, value: unknown): string | null {
  const validate = schemaValidator(name);
  if (validate(value)) return null;
  const error = validate.errors?.[0];
  return error ? `${error.instancePath || "document"} ${error.message ?? "is not valid"}` : "document is not valid";
}
