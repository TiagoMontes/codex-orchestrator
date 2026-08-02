import { describe, expect, it } from "vitest";
import type { DeepDoctorProbe } from "../../../src/application/doctor/doctor-types.js";
import { DoctorService } from "../../../src/application/doctor/doctor-service.js";
import type { LocalDoctorSystem } from "../../../src/application/doctor/local-doctor-system.js";
import type { ConfigService } from "../../../src/application/configuration/config-service.js";

class CountingProbe implements DeepDoctorProbe {
  calls = 0;

  run(): Promise<string> {
    this.calls += 1;
    return Promise.resolve("probe passed");
  }
}

describe("DoctorService", () => {
  it("never invokes a model probe during a normal doctor run", async () => {
    const probe = new CountingProbe();
    const config = {
      load: () => Promise.reject(new Error("not initialized")),
      paths: {},
    } as unknown as ConfigService;
    const system = {
      checks: () => Promise.resolve([{ name: "node", status: "pass", message: "ok" }] as const),
    } as unknown as LocalDoctorSystem;
    const doctor = new DoctorService(config, { system, deepProbe: probe });

    const report = await doctor.run({ deep: false });

    expect(probe.calls).toBe(0);
    expect(report.modelCallPerformed).toBe(false);
    expect(report.overallStatus).toBe("healthy");
  });

  it("runs exactly one explicitly requested deep probe", async () => {
    const probe = new CountingProbe();
    const config = {
      load: () => Promise.reject(new Error("not initialized")),
      paths: {},
    } as unknown as ConfigService;
    const system = {
      checks: () => Promise.resolve([{ name: "node", status: "pass", message: "ok" }] as const),
    } as unknown as LocalDoctorSystem;
    const doctor = new DoctorService(config, { system, deepProbe: probe });

    const report = await doctor.run({ deep: true });

    expect(probe.calls).toBe(1);
    expect(report.modelCallPerformed).toBe(true);
    expect(report.checks.at(-1)).toMatchObject({ name: "codex-deep", status: "pass" });
  });
});
