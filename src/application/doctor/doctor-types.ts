import { z } from "zod";

export const doctorCheckSchema = z
  .object({
    name: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    message: z.string(),
  })
  .strict();

export const doctorReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    overallStatus: z.enum(["healthy", "degraded", "failed"]),
    deep: z.boolean(),
    modelCallPerformed: z.boolean(),
    warning: z.string().optional(),
    checks: z.array(doctorCheckSchema),
  })
  .strict();

export type DoctorCheck = z.infer<typeof doctorCheckSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export interface DoctorRunner {
  run(options: { deep: boolean }): Promise<DoctorReport>;
}

export interface DeepDoctorProbe {
  run(options: { model: string; timeoutMs: number }): Promise<string>;
}
