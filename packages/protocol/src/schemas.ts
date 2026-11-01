import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import releaseSchema from '../schemas/release-manifest-0.1.schema.json' with { type: 'json' };
import inventorySchema from '../schemas/catalog-inventory-0.1.schema.json' with { type: 'json' };
import type { CatalogInventory, Issue, ReleaseManifest } from './types.ts';

export { releaseSchema, inventorySchema };

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
const releaseValidator = ajv.compile<ReleaseManifest>(releaseSchema);
const inventoryValidator = ajv.compile<CatalogInventory>(inventorySchema);

function toIssues(errors: ErrorObject[] | null | undefined): Issue[] {
  return (errors ?? []).slice(0, 20).map((e) => ({
    code: 'schema_invalid',
    message: `${e.instancePath || '<root>'} ${e.message ?? 'is invalid'}`,
  }));
}

export function validateManifestSchema(value: unknown): Issue[] {
  return releaseValidator(value) ? [] : toIssues(releaseValidator.errors);
}

export function validateInventorySchema(value: unknown): Issue[] {
  return inventoryValidator(value) ? [] : toIssues(inventoryValidator.errors);
}

const outputValidators = new Map<string, ReturnType<typeof ajv.compile>>();

/** Validate a stage result against the bundled operation contract's output schema. */
export function validateOperationOutput(contract: { id: string; output_schema: Record<string, unknown> }, value: unknown): Issue[] {
  let v = outputValidators.get(contract.id);
  if (!v) {
    v = ajv.compile(contract.output_schema);
    outputValidators.set(contract.id, v);
  }
  return v(value) ? [] : toIssues(v.errors).map((i) => ({ ...i, code: 'output_invalid' }));
}
