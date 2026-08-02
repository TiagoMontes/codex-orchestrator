export interface OutputWriter {
  write(message: string): void;
  writeError(message: string): void;
}

export const consoleOutput: OutputWriter = {
  write: (message) => process.stdout.write(`${message}\n`),
  writeError: (message) => process.stderr.write(`${message}\n`),
};

export function writeResult(writer: OutputWriter, value: unknown, json: boolean): void {
  if (json) {
    writer.write(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    writer.write(value);
    return;
  }

  writer.write(JSON.stringify(value, null, 2));
}
