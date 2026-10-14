type RuntimeLogLevel = "info" | "warn" | "error";

type RuntimeLogFields = Record<string, unknown>;

export function errorLogFields(error: unknown): RuntimeLogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

export function runtimeLog(
  level: RuntimeLogLevel,
  event: string,
  fields: RuntimeLogFields = {},
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}
