// GET /api/config -> a tiny script that sets window.TRUCKLE_CONFIG.
// Loaded with a plain <script> tag so the app knows, before it boots, whether
// it is running against the real backend or as the offline demo.
// Only public values go here (the Supabase anon key is designed to be public).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_lib.js';

export function GET() {
  const url = SUPABASE_URL(), anon = SUPABASE_ANON_KEY();
  const pk = (process.env.STRIPE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '').trim();
  const sk = (process.env.STRIPE_SECRET_KEY || '').trim();
  const cfg = url && anon ? {
    supabaseUrl: url,
    supabaseAnonKey: anon,
    stripePublishableKey: pk || null,
    payEnabled: !!sk,
    stripeMode: sk.startsWith('sk_live_') ? 'live' : 'test',
  } : null;
  return new Response(`window.TRUCKLE_CONFIG=${JSON.stringify(cfg)};`, {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
