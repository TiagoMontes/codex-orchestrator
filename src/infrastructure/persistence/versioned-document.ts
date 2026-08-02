import { z, type ZodType } from "zod";
import { OrchestratorError } from "../../shared/errors.js";

const versionProbeSchema = z.object({ schemaVersion: z.number().int().positive() }).passthrough();

export type DocumentMigration = {
  fromVersion: number;
  toVersion: number;
  migrate(input: unknown): unknown;
};

export class VersionedDocumentParser<T> {
  constructor(
    private readonly currentVersion: number,
    private readonly schema: ZodType<T>,
    private readonly migrations: readonly DocumentMigration[] = [],
  ) {}

  parse(input: unknown): T {
    const probe = versionProbeSchema.safeParse(input);
    if (!probe.success) {
      throw new OrchestratorError("Stored document is missing a valid schemaVersion", {
        code: "CONFIGURATION",
        cause: probe.error,
      });
    }
    if (probe.data.schemaVersion > this.currentVersion) {
      throw new OrchestratorError(
        `Stored schema version ${probe.data.schemaVersion} is newer than supported version ${this.currentVersion}`,
        { code: "CONFIGURATION" },
      );
    }

    let candidate = input;
    let version = probe.data.schemaVersion;
    for (let step = 0; version < this.currentVersion && step <= this.migrations.length; step += 1) {
      const migration = this.migrations.find((item) => item.fromVersion === version);
      if (migration === undefined || migration.toVersion <= version) {
        throw new OrchestratorError(`No valid migration exists from schema version ${version}`, {
          code: "CONFIGURATION",
        });
      }
      candidate = migration.migrate(candidate);
      version = migration.toVersion;
    }

    const parsed = this.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new OrchestratorError("Stored document failed validation after migration", {
        code: "CONFIGURATION",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
