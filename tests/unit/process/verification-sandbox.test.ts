import { describe, expect, it } from "vitest";
import {
  LINUX_READ_ONLY_ROOTS,
  MACOS_READ_ONLY_ROOTS,
  seatbeltProfile,
} from "../../../src/infrastructure/process/verification-sandbox.js";

describe("verification sandbox plan", () => {
  it("does not expose broad system or host configuration roots", () => {
    expect(LINUX_READ_ONLY_ROOTS).not.toContain("/usr");
    expect(LINUX_READ_ONLY_ROOTS).not.toContain("/opt");
    expect(LINUX_READ_ONLY_ROOTS.some((path) => path.endsWith("/etc"))).toBe(false);
    expect(MACOS_READ_ONLY_ROOTS).not.toContain("/usr");
    expect(MACOS_READ_ONLY_ROOTS.some((path) => path.includes("/etc"))).toBe(false);
    expect(MACOS_READ_ONLY_ROOTS).toContain("/Library/Developer/CommandLineTools");
  });

  it("builds a fail-closed Seatbelt profile without broad /usr or OpenSSL config access", () => {
    const profile = seatbeltProfile("/private/tmp/project", "/private/tmp/sandbox");

    expect(profile).toContain('(subpath "/usr/bin")');
    expect(profile).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain("/usr/local/etc");
    expect(profile).not.toContain('(subpath "/opt/homebrew/etc")');
    expect(profile).toContain('(literal "/opt/homebrew/etc/openssl@3/openssl.cnf")');
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(subpath "/private/tmp/project")');
  });
});
