import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export type VerificationSandboxKind = "seatbelt" | "bubblewrap";

export type VerificationSandboxLaunch = {
  command: string;
  args: string[];
  environment: Record<string, string>;
  kind: VerificationSandboxKind;
  cleanup(): Promise<void>;
};

export type VerificationSandboxUnavailable = {
  error: string;
};

export const LINUX_READ_ONLY_ROOTS = [
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/lib64",
  "/usr/libexec",
  "/usr/share",
  "/usr/include",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/lib",
  "/usr/local/lib64",
  "/usr/local/share",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/nix/store",
] as const;

export const MACOS_READ_ONLY_ROOTS = [
  "/System",
  "/Library/Apple",
  "/Library/Developer/CommandLineTools",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/usr/include",
  "/bin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/lib",
  "/opt/homebrew/opt",
  "/opt/homebrew/share",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/Cellar",
  "/usr/local/lib",
  "/usr/local/opt",
  "/usr/local/share",
  "/Applications/Xcode.app",
] as const;

export const MACOS_READ_ONLY_FILES = [
  "/opt/homebrew/etc/openssl@3/openssl.cnf",
  "/usr/local/etc/openssl@3/openssl.cnf",
] as const;

export async function prepareVerificationSandbox(input: {
  argv: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}): Promise<VerificationSandboxLaunch | VerificationSandboxUnavailable> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), "cxo-verification-"));
  const sandboxHome = join(sandboxRoot, "home");
  const sandboxTemp = join(sandboxRoot, "tmp");
  await Promise.all([
    mkdir(sandboxHome, { recursive: true, mode: 0o700 }),
    mkdir(sandboxTemp, { recursive: true, mode: 0o700 }),
  ]);
  const environment: Record<string, string> = {
    ...input.environment,
    HOME: sandboxHome,
    TMPDIR: sandboxTemp,
  };
  const cleanup = async (): Promise<void> => {
    await rm(sandboxRoot, { recursive: true, force: true });
  };

  if (process.platform === "darwin") {
    const executable = "/usr/bin/sandbox-exec";
    if (!(await isExecutable(executable))) {
      await cleanup();
      return { error: "macOS sandbox-exec is unavailable; verification was not started" };
    }
    return {
      command: executable,
      args: ["-p", seatbeltProfile(input.cwd, sandboxRoot), "--", ...input.argv],
      environment,
      kind: "seatbelt",
      cleanup,
    };
  }

  if (process.platform === "linux") {
    const executable = await findTrustedBubblewrap();
    if (executable === undefined) {
      await cleanup();
      return {
        error:
          "a root-owned, non-writable bubblewrap (bwrap) installation is required for isolated verification on Linux; verification was not started",
      };
    }
    const visibleSystemRoots = LINUX_READ_ONLY_ROOTS;
    const visibleSystemFiles = [
      "/etc/ld.so.cache",
      "/etc/nsswitch.conf",
      "/etc/passwd",
      "/etc/group",
      "/etc/hosts",
      "/etc/localtime",
    ];
    return {
      command: executable,
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-net",
        "--unshare-uts",
        "--unshare-cgroup-try",
        ...directoryCreationArgs([
          ...visibleSystemRoots,
          "/proc",
          "/dev",
          "/run",
          "/tmp",
          "/var/tmp",
          "/etc",
          input.cwd,
          sandboxRoot,
        ]),
        ...visibleSystemRoots.flatMap((path) => ["--ro-bind-try", path, path]),
        ...visibleSystemFiles.flatMap((path) => ["--ro-bind-try", path, path]),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind-try",
        "/dev/null",
        "/etc/shadow",
        "--ro-bind-try",
        "/dev/null",
        "/etc/gshadow",
        "--bind",
        input.cwd,
        input.cwd,
        "--bind",
        sandboxRoot,
        sandboxRoot,
        "--chdir",
        input.cwd,
        "--setenv",
        "HOME",
        sandboxHome,
        "--setenv",
        "TMPDIR",
        sandboxTemp,
        "--",
        ...input.argv,
      ],
      environment,
      kind: "bubblewrap",
      cleanup,
    };
  }

  await cleanup();
  return {
    error: `Verification sandboxing is unsupported on ${process.platform}; verification was not started`,
  };
}

export function seatbeltProfile(cwd: string, sandboxRoot: string): string {
  const readOnlyRoots = [...MACOS_READ_ONLY_ROOTS, cwd, sandboxRoot];
  const readable = [
    ...readOnlyRoots.map((path) => `(subpath ${seatbeltString(path)})`),
    ...MACOS_READ_ONLY_FILES.map((path) => `(literal ${seatbeltString(path)})`),
  ].join(" ");
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    `(allow sysctl-read ${MACOS_RUNTIME_SYSCTLS.map((name) => `(sysctl-name ${seatbeltString(name)})`).join(" ")})`,
    "(allow process-fork process-exec*)",
    "(allow signal (target self))",
    "(allow signal (target children))",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target self))",
    "(allow process-info* (target children))",
    "(allow dynamic-code-generation)",
    "(allow file-read-metadata file-test-existence)",
    '(allow file-read-data (literal "/"))',
    `(allow file-read* file-map-executable ${readable})`,
    `(allow file-write* (subpath ${seatbeltString(cwd)}))`,
    `(allow file-write* (subpath ${seatbeltString(sandboxRoot)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
  ].join("\n");
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}

function directoryCreationArgs(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = resolve(path);
    const root = parse(current).root;
    while (current !== root) {
      directories.add(current);
      current = dirname(current);
    }
  }
  return [...directories]
    .sort((left, right) => left.split("/").length - right.split("/").length)
    .flatMap((path) => ["--dir", path]);
}

async function findTrustedBubblewrap(): Promise<string | undefined> {
  const candidates = [
    "/usr/bin/bwrap",
    "/bin/bwrap",
    "/usr/local/bin/bwrap",
    "/run/current-system/sw/bin/bwrap",
    "/nix/var/nix/profiles/default/bin/bwrap",
  ];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      const inSystemRoot = ["/usr/", "/bin/", "/nix/store/"].some((root) =>
        canonical.startsWith(root),
      );
      if (
        inSystemRoot &&
        metadata.isFile() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0 &&
        (await hasTrustedAncestors(canonical)) &&
        (await isExecutable(canonical))
      ) {
        return canonical;
      }
    } catch {
      // Try the next fixed system location.
    }
  }
  return undefined;
}

async function hasTrustedAncestors(path: string): Promise<boolean> {
  let current = dirname(path);
  for (;;) {
    const metadata = await stat(current);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

const MACOS_RUNTIME_SYSCTLS = [
  "hw.machine",
  "hw.memsize",
  "hw.model",
  "hw.ncpu",
  "hw.cpufrequency",
  "hw.ephemeral_storage",
  "hw.optional.armv8_2_sha3",
  "hw.optional.armv8_2_sha512",
  "hw.pagesize_compat",
  "kern.bootargs",
  "kern.hostname",
  "kern.ostype",
  "kern.osrelease",
  "kern.version",
  "kern.iossupportversion",
  "kern.osproductversion",
  "kern.osvariant_status",
  "kern.willshutdown",
  "machdep.cpu.brand_string",
  "security.mac.lockdown_mode_state",
] as const;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
