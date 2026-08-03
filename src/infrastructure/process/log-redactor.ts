const REDACTION = "[REDACTED]";

const REDACTION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replace: string;
}> = [
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu,
    replace: `$1${REDACTION}`,
  },
  {
    pattern:
      /(^|\s)(--?[A-Za-z0-9_-]*(?:token|api[-_]?key|secret|password|passphrase|auth(?:orization)?|cookie)[A-Za-z0-9_-]*)(\s+|=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gimu,
    replace: `$1$2$3${REDACTION}`,
  },
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE|DATABASE_URL|AWS_[A-Za-z0-9_]*|GCP_[A-Za-z0-9_]*|AZURE_[A-Za-z0-9_]*)\s*[=:]\s*)([^\s,;]+)/giu,
    replace: `$1${REDACTION}`,
  },
  {
    pattern:
      /("(?:token|apiKey|secret|password|authorization|cookie|databaseUrl)"\s*:\s*")[^"]*(")/giu,
    replace: `$1${REDACTION}$2`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    replace: `$1${REDACTION}@`,
  },
];

export class LogRedactor {
  redact(input: string): string {
    return REDACTION_PATTERNS.reduce(
      (redacted, { pattern, replace }) => redacted.replace(pattern, replace),
      input,
    );
  }
}
