"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client — uses the publishable (anon) key. RLS protects data. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
