import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import releaseSchema from '../schemas/release-manifest-0.2.schema.json' with { type: 'json' };
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
