import type { FieldChange } from '../services/activity-log.service';

type SettingValue = string | number | boolean;

/**
 * The supplied (non-undefined) members of a partial settings update,
 * restricted to `fields`. Anything else on `input` is ignored.
 */
export function pickDefinedFields<T extends { [K in keyof T]: SettingValue }>(
  input: Partial<T>,
  fields: readonly (keyof T)[],
): Partial<T> {
  const data: Partial<T> = {};
  for (const field of fields) {
    if (input[field] !== undefined) data[field] = input[field];
  }
  return data;
}

/** The audit entries (old and new value) of the fields that changed. */
export function changedFields<T extends { [K in keyof T]: SettingValue }>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): FieldChange[] {
  return fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({
      fieldName: field,
      oldValue: String(before[field]),
      newValue: String(after[field]),
    }));
}
