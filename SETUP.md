# Truckle backend and Truckle Pay setup (test mode)

The app is still one `index.html`. On Vercel it now also has:

| Piece | What it does |
|---|---|
| `api/config` | Tells the app whether a backend is set up. Sends only public values. |
| `api/workspace` | After sign-in, finds, creates or joins (with `?join=CODE`) the user's workspace. |
| `api/connect/onboard`, `api/connect/status` | Stripe Connect Express setup for crew (payouts) and companies (taking customer payments). |
| `api/pay/checkout` | Starts a Stripe Checkout for a crew bill or a customer invoice. The server works out the amount from the saved invoice. |
| `api/pay/invoice` + `pay.html` | The customer pay-link page. No sign-in needed. |
| `api/stripe/webhook` | Marks invoices paid, sends the in-app notifications and chat message, and syncs payout status. |
| `live.js` | In the browser: swaps the demo store for Supabase with realtime sync, and connects sign-in to Supabase Auth. |
| `supabase/migrations/0001_truckle.sql` | Tables, row-level security, realtime. |

With no keys set, the site stays the offline demo. Add `?demo` to any URL to force the demo on that device, and `?live` to switch back.

## 1. Supabase (project "Truckle", Sydney)
1. Go to **SQL Editor → New query**, paste all of `supabase/migrations/0001_truckle.sql`, then **Run**. It is safe to run again.
2. Under **Authentication → URL Configuration**, set **Site URL** to your Vercel URL. Add `https://*.vercel.app/**` to the redirect URLs.
3. Optional, for faster testing: under **Authentication → Providers → Email**, turn off **Confirm email**.
4. Optional: to use the Google, Apple or Facebook sign-in buttons, turn each provider on in the same place. Until you do, those buttons tell people to use email.
5. Under **Project Settings → API**, copy the **Project URL**, the **anon** key and the **service_role** key.

## 2. Vercel
1. Go to **Add New → Project → Import** `ghakimc-sudo/truckle`. Framework preset: **Other**. Leave the build settings empty.
2. Under **Settings → Environment Variables**, add each variable in `.env.example` and tick all three environments. Mark the secret ones as **Sensitive**.
3. Redeploy.

## 3. Stripe sandbox "Truckle"
1. Copy the **pk_test_** and **sk_test_** keys from **Developers → API keys** into Vercel.
2. Under **Developers → Webhooks → Add endpoint**, use the URL `https://<your-vercel-url>/api/stripe/webhook`.
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `account.updated`.
   - Also listen to events from **connected accounts**, so that `account.updated` arrives.
   - Put the signing secret in Vercel as `STRIPE_WEBHOOK_SECRET`. If Stripe makes you create a separate endpoint for connected accounts, put that one's secret in `STRIPE_CONNECT_WEBHOOK_SECRET`.
3. Under **Settings → Payment methods**, turn on **BECS Direct Debit** and **PayTo** if you want them. If they're off, checkout falls back to card by itself.
4. Redeploy after adding the keys.

## 4. Try it end to end
1. Open the site, sign up with email and choose **I run a removal company**.
2. Go to **Settings → Turn on Truckle Pay**. In Stripe's test onboarding, use the test values it suggests (for example, BSB `000-000` and account `000123456`).
3. Copy the **invite link** and open it in another browser. Sign up as a worker, then go to **Set up payouts**.
4. For a crew bill: tap **Pay** and use card `4242 4242 4242 4242`, any future date and any CVC. The bill turns paid a few seconds later.
5. For a customer invoice: after a job, tap **Invoice customer**, copy the **pay link**, open it and pay with the same test card.

Live keys (`sk_live_`) are refused unless `TRUCKLE_ALLOW_LIVE=1` is set.

## Tests
`npm install && npm test` runs the fee, checkout, webhook and workspace tests against an in-memory fake of Supabase and Stripe.
