import { createClient } from "@supabase/supabase-js";

import { getConfig } from "../config.ts";

let client: ReturnType<typeof createClient> | undefined;

export function getSupabaseAdmin() {
  if (client) return client;

  const config = getConfig();
  client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return client;
}
