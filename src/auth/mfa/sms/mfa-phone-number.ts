/**
 * Phone numbers of SMS verification: international E.164 numbers (`+`,
 * country code, 8 to 15 digits in total). Spaces, hyphens, dots and
 * parentheses are accepted in input and removed.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** The E.164 form of `input`, or null when it is not a valid number. */
export function normalizePhoneNumber(input: string): string | null {
  const compact = input.trim().replace(/[\s().-]/g, '');
  return E164.test(compact) ? compact : null;
}

/**
 * What is shown of a number: `+` and its last four digits, the others
 * masked (`+*******4567`). Never enough to reach the user.
 */
export function maskPhoneNumber(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return `+${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
