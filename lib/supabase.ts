import { createClient } from "@supabase/supabase-js";

// Server only: the secret key never reaches the browser.
export const db = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
