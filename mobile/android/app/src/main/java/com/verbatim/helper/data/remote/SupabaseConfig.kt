package com.verbatim.helper.data.remote

/**
 * Public Supabase project coordinates. The publishable (anon) key is DESIGNED to ship in clients
 * — the web app already sends it to every browser — and Row-Level Security is what actually guards
 * the data. The secret service-role key never lives here.
 */
object SupabaseConfig {
    const val URL = "https://yteqbxsqzzmttkbcatek.supabase.co"
    const val ANON_KEY = "sb_publishable_Izl1D0O7UHt8rMjLkkZ3DQ_uG4OGO1J"

    const val REST = "$URL/rest/v1"
    const val AUTH = "$URL/auth/v1"

    /** The live web app that owns the agent API + export routes the app also calls. */
    const val APP_BASE = "https://yverbatim.vercel.app"
}
