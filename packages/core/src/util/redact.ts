/**
 * Best-effort PII scrubbing for free text that is about to enter a model prompt
 * (I12, §9). The vault is the *primary* mechanism — identity documents belong there
 * and never enter memory or prompts at all — but users type secrets into chat, so
 * every prompt-assembly site passes utterance/evidence text through this scrub.
 *
 * Patterns are deliberately conservative: long digit runs (payment cards), SSN
 * shapes, and passport-shaped identifiers (1–2 letters + 6–9 digits). Short codes
 * like flight numbers (UA482), rooms (814), order ids (amz-7719) and phone numbers
 * do not match. Limits are documented in DECISIONS D-010.
 */

const PATTERNS: { kind: string; re: RegExp }[] = [
  // payment-card-like: 13–19 digits allowing space/dash separators
  { kind: 'card', re: /\b(?:\d[ -]?){12,18}\d\b/g },
  // US SSN shape
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // passport-shaped: 1–2 uppercase letters followed by 6–9 digits
  { kind: 'id-document', re: /\b[A-Z]{1,2}\d{6,9}\b/g },
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, `[redacted:${kind}]`);
  }
  return out;
}

/** True when the scrub would change the text (useful for warnings/audit). */
export function containsSensitiveText(text: string): boolean {
  return PATTERNS.some(({ re }) => new RegExp(re.source).test(text));
}
