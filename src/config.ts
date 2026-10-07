type Config = {
  port: number;
  frontendUrl: string;
  allowedOrigins: Set<string>;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  superAdminEmails: Set<string>;
};

let cachedConfig: Config | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function commaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const origins = commaSeparated(process.env.FRONTEND_URL);
  const frontendUrl = origins[0] ?? "http://localhost:3000";
  const port = Number(process.env.PORT ?? 5001);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }

  cachedConfig = {
    port,
    frontendUrl,
    allowedOrigins: new Set(origins.length ? origins : [frontendUrl]),
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    superAdminEmails: new Set(
      commaSeparated(process.env.SUPER_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    ),
  };

  return cachedConfig;
}

export function isBootstrapSuperAdmin(email: string): boolean {
  return getConfig().superAdminEmails.has(email.toLowerCase());
}
