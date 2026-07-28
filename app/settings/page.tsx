import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "@/components/settings-form";
import type { Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PROFILE = {
  default_theme: "paper" as const,
  font_family: "read" as const,
  font_size: 18,
  reading_width: "default" as const,
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRow ?? {}) };

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Settings</h1>
      <p className="mt-1.5 text-muted">Set how your reading experience looks by default.</p>
      <div className="mt-10">
        <SettingsForm profile={profile} email={user.email ?? ""} />
      </div>
    </main>
  );
}
