const DEFAULT_OPERATIONAL_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

const SECRET_NAME_PATTERN =
  /(TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE|DATABASE_URL|AWS_|GCP_|AZURE_)/iu;
const UNSAFE_LOADER_NAME_PATTERN =
  /^(?:BASH_ENV|ENV|GIT_CONFIG(?:_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM)|LD_|DYLD_|NODE_OPTIONS|PERL5OPT|PYTHONPATH|RUBYOPT)/u;

export type SanitizeEnvironmentOptions = {
  additionalAllowedNames?: readonly string[];
  explicitSecretExceptions?: readonly string[];
};

export type SanitizedEnvironment = {
  environment: Record<string, string>;
  warnings: string[];
};

export class EnvironmentSanitizer {
  constructor(private readonly baseAllowlist: readonly string[] = DEFAULT_OPERATIONAL_ALLOWLIST) {}

  sanitize(
    source: Readonly<Record<string, string | undefined>>,
    options: SanitizeEnvironmentOptions = {},
  ): SanitizedEnvironment {
    const allowed = new Set([...this.baseAllowlist, ...(options.additionalAllowedNames ?? [])]);
    const exceptions = new Set(options.explicitSecretExceptions ?? []);
    const environment: Record<string, string> = {};
    const warnings: string[] = [];

    for (const name of [...allowed].sort()) {
      const value = source[name];
      if (value === undefined) {
        continue;
      }
      if (UNSAFE_LOADER_NAME_PATTERN.test(name)) {
        warnings.push(`Omitted unsafe loader or startup environment variable ${name}`);
        continue;
      }
      if (SECRET_NAME_PATTERN.test(name) && !exceptions.has(name)) {
        warnings.push(`Omitted sensitive environment variable ${name}`);
        continue;
      }
      if (SECRET_NAME_PATTERN.test(name)) {
        warnings.push(
          `Included explicitly excepted sensitive variable ${name}; its value will not be logged`,
        );
      }
      environment[name] = value;
    }

    return { environment, warnings };
  }
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}
