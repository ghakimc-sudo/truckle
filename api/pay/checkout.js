// POST /api/pay/checkout
//   { workspaceId, kind: 'invoice', id, method }   company pays a crew bill (signed in)
//   { workspaceId, kind: 'cinvoice', id, method }  customer pays a company invoice (pay link, no sign-in)
// Amounts are always worked out here from the stored invoice, never taken from the browser.
// Money moves as a Stripe destination charge: the payer is charged, the payee's
// Connect account receives its share, and Truckle keeps the application fee.
import {
  admin, stripe, route, json, readJson, requireUser, requireMember, origin, getDoc, companyPath,
  crewBillQuote, custInvoiceQuote, cents, invCo, HttpError, isUuid,
} from '../_lib.js';

async function accountFor(ws, kind, id) {
  const { data, error } = await admin().from('connect_accounts')
    .select('stripe_account_id, charges_enabled, payouts_enabled')
    .eq('workspace_id', ws).eq('party_kind', kind).eq('party_id', id).maybeSingle();
  if (error) throw error;
  return data && data.charges_enabled ? data.stripe_account_id : null;
}

export const POST = route(async (request) => {
  const body = await readJson(request);
  const { workspaceId: ws, kind, id } = body;
  if (!isUuid(ws) || !id || !['invoice', 'cinvoice'].includes(kind)) throw new HttpError(400, 'Missing invoice.');
  const base = origin(request);
  let session;

  if (kind === 'invoice') {
    const user = await requireUser(request);
    await requireMember(user, ws);
    const inv = await getDoc(ws, 'invoices', id);
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (inv.status === 'paid') throw new HttpError(409, 'This bill is already paid.');
    const crew = (await getDoc(ws, 'crew', inv.crewId)) || {};
    const dest = await accountFor(ws, 'crew', inv.crewId);
    if (!dest) throw new HttpError(409, `${crew.name || 'This worker'} hasn't turned on payouts yet. Pay by bank transfer for now.`);
    const method = body.method || 'payto';
    const q = crewBillQuote(+inv.total || 0, method);
    if (q.charged < 0.5) throw new HttpError(400, 'Amount is too small to pay by card or bank.');
    const [cc, cd] = companyPath(invCo(inv));
    const co = (await getDoc(ws, cc, cd)) || {};
    const meta = {
      truckle_workspace: ws, truckle_kind: kind, truckle_id: id, truckle_method: method,
      processing_fee: String(q.proc), platform_fee: String(q.plat), payout: String(q.payout),
    };
    session = await createSession({
      types: q.types,
      line_items: [
        line(`Invoice ${inv.number || ''} · ${crew.name || 'crew'}`.trim(), q.payout),
        line(`${q.label} processing`, q.proc),
        line('Truckle fee', q.plat),
      ].filter(Boolean),
      payment_intent_data: {
        application_fee_amount: cents(q.proc + q.plat),
        transfer_data: { destination: dest },
        description: `Truckle: ${co.name || 'Company'} paid ${crew.name || 'crew'} for ${inv.number || id}`,
        metadata: meta,
      },
      customer_email: co.email || undefined,
      success_url: `${base}/?paid=invoice&inv=${encodeURIComponent(id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?paycancel=invoice&inv=${encodeURIComponent(id)}`,
      metadata: meta,
      client_reference_id: `${ws}:${kind}:${id}`,
    });
    await record(ws, kind, id, method, session, cents(q.charged), cents(q.proc + q.plat), dest);
  } else {
    const c = await getDoc(ws, 'cinvoices', id);
    if (!c) throw new HttpError(404, 'Invoice not found.');
    if (c.status === 'paid') throw new HttpError(409, 'This invoice is already paid. Thank you!');
    const coId = c.companyId || 'org';
    const [cc, cd] = companyPath(coId);
    const co = (await getDoc(ws, cc, cd)) || {};
    const dest = await accountFor(ws, 'company', coId);
    if (!dest) throw new HttpError(409, `${co.name || 'This company'} can't take card or bank payments in Truckle yet. Ask them for their bank details.`);
    const method = body.method || 'card';
    const q = custInvoiceQuote(+c.total || 0, method);
    if (q.charged < 0.5) throw new HttpError(400, 'Amount is too small to pay by card or bank.');
    const meta = {
      truckle_workspace: ws, truckle_kind: kind, truckle_id: id, truckle_method: method,
      processing_fee: String(q.fee), platform_fee: String(q.plat), net: String(q.net),
    };
    const fromPage = body.returnTo === 'page';
    const back = fromPage
      ? `${base}/pay.html?w=${ws}&i=${encodeURIComponent(id)}`
      : `${base}/?`;
    session = await createSession({
      types: q.types,
      line_items: [line(`Invoice ${c.number || ''} · ${co.name || 'Removals'}`.trim(), q.charged)],
      payment_intent_data: {
        application_fee_amount: cents(q.fee + q.plat),
        transfer_data: { destination: dest },
        description: `Truckle: ${c.customer || 'Customer'} paid ${co.name || 'company'} for ${c.number || id}`,
        metadata: meta,
      },
      customer_email: c.email || undefined,
      success_url: fromPage ? `${back}&done=1` : `${back}paid=cinvoice&inv=${encodeURIComponent(id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: fromPage ? back : `${back}paycancel=cinvoice&inv=${encodeURIComponent(id)}`,
      metadata: meta,
      client_reference_id: `${ws}:${kind}:${id}`,
    });
    await record(ws, kind, id, method, session, cents(q.charged), cents(q.fee + q.plat), dest);
  }
  return json({ url: session.url, id: session.id, fallback: session._fallback || null });
});

function line(name, amount) {
  if (!(amount > 0)) return null;
  return { quantity: 1, price_data: { currency: 'aud', unit_amount: cents(amount), product_data: { name } } };
}

// Create the Checkout Session. If a bank method (PayTo / BECS) isn't switched on
// for this Stripe account yet, fall back to card so the payer isn't stuck.
async function createSession({ types, ...params }) {
  const s = stripe();
  const base = { mode: 'payment', locale: 'en', ...params };
  try {
    return await s.checkout.sessions.create({ ...base, payment_method_types: types });
  } catch (e) {
    const bank = !(types.length === 1 && types[0] === 'card');
    if (bank && e && e.type === 'StripeInvalidRequestError') {
      console.warn('bank method unavailable, falling back to card:', e.message);
      const out = await s.checkout.sessions.create({ ...base, payment_method_types: ['card'] });
      out._fallback = 'card';
      return out;
    }
    throw e;
  }
}

async function record(ws, kind, id, method, session, amount, fee, dest) {
  const { error } = await admin().from('payments').insert({
    workspace_id: ws, kind, invoice_id: id, checkout_session_id: session.id, method,
    amount_cents: amount, application_fee_cents: fee, destination: dest, status: 'open', livemode: !!session.livemode,
  });
  if (error) throw error;
}
