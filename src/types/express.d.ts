import type { User as SupabaseUser } from "@supabase/supabase-js";

export type AppRole = "USER" | "MODERATOR" | "ADMIN" | "SUPER_ADMIN";
export type AppAccountType = "STANDARD" | "TESTER" | "DEMO" | "INTERNAL";

export type AppUserIdentity = {
  id: string;
  email: string;
  fullName: string;
  avatarPath: string | null;
  role: AppRole;
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  accountType: AppAccountType;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: SupabaseUser;
      appUser?: AppUserIdentity;
    }
  }
}
