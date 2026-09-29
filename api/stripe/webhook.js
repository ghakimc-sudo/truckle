// POST /api/stripe/webhook   (set this URL in Stripe -> Developers -> Webhooks)
// Events: checkout.session.completed, checkout.session.async_payment_succeeded,
//         checkout.session.async_payment_failed, checkout.session.expired, account.updated
// Tick "Listen to events on Connected accounts" as well for account.updated.
import { admin, stripe, json } from '../_lib.js';
import { settle } from '../pay/_settle.js';
import { syncAccount } from '../connect/_sync.js';

export async function POST(request) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET]
    .map((s) => (s || '').trim()).filter(Boolean);
  if (!secrets.length) return json({ error: 'STRIPE_WEBHOOK_SECRET is not set' }, 503);
  const sig = request.headers.get('stripe-signature') || '';
  const raw = await request.text();

  let event = null;
  for (const secret of secrets) {
    try { event = stripe().webhooks.constructEvent(raw, sig, secret); break; } catch { /* try next */ }
  }
  if (!event) return json({ error: 'Bad signature' }, 400);

  // De-duplicate: Stripe retries, and may deliver the same event twice.
  const { error: dup } = await admin().from('stripe_events').insert({ id: event.id, type: event.type });
  if (dup) {
    if (dup.code === '23505') return json({ received: true, duplicate: true });
    console.error('stripe_events insert', dup);
    return json({ error: 'db' }, 500);
  }

  try {
    const o = event.data.object;
    let result = 'ignored';
    switch (event.type) {
      case 'checkout.session.completed':
        result = await settle(o, o.payment_status === 'paid' || o.payment_status === 'no_payment_required' ? 'succeeded' : 'processing');
        break;
      case 'checkout.session.async_payment_succeeded':
        result = await settle(o, 'succeeded');
        break;
      case 'checkout.session.async_payment_failed':
        result = await settle(o, 'failed');
        break;
      case 'checkout.session.expired':
        await admin().from('payments').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('checkout_session_id', o.id);
        result = 'expired';
        break;
      case 'account.updated':
        result = (await syncAccount(o)) ? 'account synced' : 'ignored: unknown account';
        break;
    }
    return json({ received: true, result });
  } catch (e) {
    // Let Stripe retry: forget we saw it.
    console.error('webhook handling failed', event.type, e);
    await admin().from('stripe_events').delete().eq('id', event.id);
    return json({ error: 'handler failed' }, 500);
  }
}
