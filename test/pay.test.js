import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeSupabase } from './fake-supabase.js';

const SB = 'https://fake.supabase.co';
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.APP_URL = 'https://truckle.test';

let fake, lib, checkout, webhook, workspace, invoiceApi, configApi;
const WS = '6f1c2b1e-0000-4000-8000-000000000001';
const USER = { id: '6f1c2b1e-0000-4000-8000-0000000000aa', email: 'boss@example.com' };

before(async () => {
  fake = installFakeSupabase(SB);
  fake.addUser('tok', USER);
  lib = await import('../api/_lib.js');
  checkout = await import('../api/pay/checkout.js');
  webhook = await import('../api/stripe/webhook.js');
  workspace = await import('../api/workspace.js');
  invoiceApi = await import('../api/pay/invoice.js');
  configApi = await import('../api/config.js');
});
after(() => fake.restore());

const post = (fn, body, token) => fn(new Request('https://truckle.test/api/x', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
}));

test('fees match the numbers the app shows (index.html PAY / CPAY / platFee)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const grab = (re) => { const m = html.match(re); assert.ok(m, 'missing ' + re); return m[0]; };
  const src = [
    'const r2=n=>Math.round(n*100)/100;',
    grab(/const PAY=\{platformPct[\s\S]*?feeTxt:'1\.7% \+ 30c'\}\}\};/),
    grab(/const platFee=[^\n]*/),
    grab(/const CPAY=[^\n]*/),
    'return {PAY,CPAY,platFee};',
  ].join('\n');
  const app = new Function(src)();
  for (const total of [0.8, 12.34, 99.99, 250, 380, 1234.56, 9999]) {
    assert.equal(lib.platFee(total), app.platFee(total), 'platFee ' + total);
    for (const m of ['payto', 'becs', 'card']) {
      const q = lib.crewBillQuote(total, m);
      assert.equal(q.proc, lib.r2(app.PAY.methods[m].fee(total)), `crew ${m} ${total}`);
      assert.equal(q.charged, lib.r2(total + q.proc + q.plat));
    }
    for (const m of ['card', 'wallet', 'payto']) {
      const q = lib.custInvoiceQuote(total, m);
      assert.equal(q.fee, lib.r2(app.CPAY[m].fee(total)), `cust ${m} ${total}`);
      assert.equal(q.net, lib.r2(total - q.fee - q.plat));
    }
  }
});

test('config script exposes only public values', async () => {
  const txt = await configApi.GET().text();
  assert.match(txt, /^window\.TRUCKLE_CONFIG=/);
  assert.ok(!txt.includes('service') && !txt.includes('sk_test') && !txt.includes('whsec'));
  assert.match(txt, /"stripeMode":"test"/);
});

test('live keys are refused unless explicitly allowed', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_live_nope';
  // fresh module instance so the cached client isn't reused
  const l = await import('../api/_lib.js?live');
  assert.throws(() => l.stripe(), /Live Stripe keys are blocked/);
  process.env.STRIPE_SECRET_KEY = saved;
});

test('workspace: create, then find again, then join by invite code', async () => {
  let r = await post(workspace.POST, { role: 'company', name: 'George' }, 'tok');
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.ok(a.created && a.joinCode);
  r = await post(workspace.POST, { role: 'company' }, 'tok');
  assert.equal((await r.json()).workspaceId, a.workspaceId);
  fake.addUser('tok2', { id: '6f1c2b1e-0000-4000-8000-0000000000bb', email: 'jay@example.com' });
  r = await post(workspace.POST, { role: 'crew', name: 'Jay', join: a.joinCode }, 'tok2');
  const b = await r.json();
  assert.equal(b.workspaceId, a.workspaceId);
  assert.equal(b.role, 'crew');
  r = await post(workspace.POST, { role: 'crew' });
  assert.equal(r.status, 401);
});

test('crew bill: checkout charges the right amount, webhook marks it paid once', async () => {
  const T = fake.tables;
  T.workspaces.push({ id: WS, name: 'Test', join_code: 'abc' });
  T.workspace_members.push({ workspace_id: WS, user_id: USER.id, role: 'company' });
  T.docs.push(
    { workspace_id: WS, coll: 'settings', id: 'org', data: { name: 'Big Move Co', email: 'boss@example.com' } },
    { workspace_id: WS, coll: 'crew', id: 'jay', data: { name: 'Jay Smith' } },
    { workspace_id: WS, coll: 'invoices', id: 'inv1', data: { number: 'JS-0007', crewId: 'jay', total: 380, status: 'sent', history: [] } },
  );

  // Not onboarded yet -> clear message, no charge
  let r = await post(checkout.POST, { workspaceId: WS, kind: 'invoice', id: 'inv1', method: 'payto' }, 'tok');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /hasn't turned on payouts/);

  T.connect_accounts.push({ workspace_id: WS, party_kind: 'crew', party_id: 'jay', stripe_account_id: 'acct_jay', charges_enabled: true });
  const calls = [];
  const s = lib.stripe();
  s.checkout.sessions.create = async (p) => {
    calls.push(p);
    if (p.payment_method_types[0] === 'payto') { const e = new Error('payto not enabled'); e.type = 'StripeInvalidRequestError'; throw e; }
    return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', livemode: false };
  };

  // Not a member -> refused
  fake.addUser('stranger', { id: '6f1c2b1e-0000-4000-8000-0000000000cc' });
  r = await post(checkout.POST, { workspaceId: WS, kind: 'invoice', id: 'inv1', method: 'payto' }, 'stranger');
  assert.equal(r.status, 403);

  r = await post(checkout.POST, { workspaceId: WS, kind: 'invoice', id: 'inv1', method: 'payto', total: 1 }, 'tok');
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.fallback, 'card', 'falls back to card when PayTo is off');
  const p = calls.at(-1);
  const sum = p.line_items.reduce((a, l) => a + l.price_data.unit_amount, 0);
  const q = lib.crewBillQuote(380, 'payto');
  assert.equal(sum, lib.cents(q.charged), 'charged = total + fees, ignoring any amount the browser sent');
  assert.equal(p.payment_intent_data.application_fee_amount, lib.cents(q.proc + q.plat));
  assert.equal(p.payment_intent_data.transfer_data.destination, 'acct_jay');
  assert.equal(T.payments.length, 1);

  // Webhook: bad signature rejected
  const evt = {
    id: 'evt_1', type: 'checkout.session.completed', data: { object: {
      id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_123', amount_total: sum, livemode: false,
      metadata: p.metadata,
    } },
  };
  const raw = JSON.stringify(evt);
  const bad = await webhook.POST(new Request('https://truckle.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: raw }));
  assert.equal(bad.status, 400);

  const sig = s.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_test' });
  const send = () => webhook.POST(new Request('https://truckle.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sig }, body: raw }));
  r = await send();
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, 'invoice paid');
  const inv = T.docs.find((d) => d.coll === 'invoices' && d.id === 'inv1').data;
  assert.equal(inv.status, 'paid');
  assert.equal(inv.paidRef, 'pi_123');
  assert.equal(inv.payment.via, 'stripe');
  assert.equal(inv.payment.payout, 380);
  assert.ok(inv.history.some((h) => /Paid in Truckle/.test(h.what)));
  const notes = T.docs.filter((d) => d.coll === 'notes');
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.data.toKind === 'crew' && n.data.toId === 'jay'));
  assert.ok(T.docs.find((d) => d.coll === 'chats' && d.id === 'jay').data.messages.length === 1);
  assert.equal(T.payments[0].status, 'succeeded');

  // Same event again -> ignored, no duplicate notes
  r = await send();
  assert.equal((await r.json()).duplicate, true);
  assert.equal(T.docs.filter((d) => d.coll === 'notes').length, 2);

  // Can't pay twice
  r = await post(checkout.POST, { workspaceId: WS, kind: 'invoice', id: 'inv1', method: 'card' }, 'tok');
  assert.equal(r.status, 409);
});

test('customer invoice: public pay link, checkout and BECS-style async settle', async () => {
  const T = fake.tables, s = lib.stripe();
  T.docs.push({ workspace_id: WS, coll: 'cinvoices', id: 'c1', data: { number: 'INV-1001', companyId: 'org', customer: 'Sam Lee', email: 'sam@example.com', total: 1234.56, gst: 112.23, gstIncl: true, lines: [{ desc: 'Move', amount: 1234.56 }], status: 'sent', history: [] } });

  let r = await invoiceApi.GET(new Request(`https://truckle.test/api/pay/invoice?w=${WS}&i=c1`));
  let x = await r.json();
  assert.equal(x.total, 1234.56);
  assert.equal(x.canPay, false);
  r = await post(checkout.POST, { workspaceId: WS, kind: 'cinvoice', id: 'c1', method: 'card', returnTo: 'page' });
  assert.equal(r.status, 409);

  T.connect_accounts.push({ workspace_id: WS, party_kind: 'company', party_id: 'org', stripe_account_id: 'acct_co', charges_enabled: true });
  let params;
  s.checkout.sessions.create = async (p) => { params = p; return { id: 'cs_2', url: 'https://checkout.stripe.test/cs_2', livemode: false }; };
  r = await post(checkout.POST, { workspaceId: WS, kind: 'cinvoice', id: 'c1', method: 'card', returnTo: 'page' });
  assert.equal(r.status, 200, await r.clone().text());
  const q = lib.custInvoiceQuote(1234.56, 'card');
  assert.equal(params.line_items[0].price_data.unit_amount, 123456);
  assert.equal(params.payment_intent_data.application_fee_amount, lib.cents(q.fee + q.plat));
  assert.equal(params.payment_intent_data.transfer_data.destination, 'acct_co');
  assert.equal(params.success_url, `https://truckle.test/pay.html?w=${WS}&i=c1&done=1`);

  const send = async (id, type, status) => {
    const raw = JSON.stringify({ id, type, data: { object: { id: 'cs_2', payment_status: status, payment_intent: 'pi_9', livemode: false, metadata: params.metadata } } });
    return webhook.POST(new Request('https://truckle.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': s.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_test' }) }, body: raw }));
  };
  r = await send('evt_2', 'checkout.session.completed', 'unpaid');
  assert.equal((await r.json()).result, 'cinvoice processing');
  x = await (await invoiceApi.GET(new Request(`https://truckle.test/api/pay/invoice?w=${WS}&i=c1`))).json();
  assert.equal(x.processing, true);
  r = await send('evt_3', 'checkout.session.async_payment_succeeded', 'paid');
  assert.equal((await r.json()).result, 'cinvoice paid');
  const c = T.docs.find((d) => d.coll === 'cinvoices' && d.id === 'c1').data;
  assert.equal(c.status, 'paid');
  assert.equal(c.payment.net, q.net);
  x = await (await invoiceApi.GET(new Request(`https://truckle.test/api/pay/invoice?w=${WS}&i=c1`))).json();
  assert.equal(x.status, 'paid');
});

test('account.updated turns payouts on for the worker', async () => {
  const s = lib.stripe(), T = fake.tables;
  const raw = JSON.stringify({ id: 'evt_4', type: 'account.updated', data: { object: {
    id: 'acct_jay', object: 'account', charges_enabled: true, payouts_enabled: true, details_submitted: true, livemode: false,
    requirements: { currently_due: [] }, external_accounts: { data: [{ object: 'bank_account', bank_name: 'Westpac', last4: '6789' }] },
  } } });
  const r = await webhook.POST(new Request('https://truckle.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': s.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_test' }) }, body: raw }));
  assert.equal((await r.json()).result, 'account synced');
  const crew = T.docs.find((d) => d.coll === 'crew' && d.id === 'jay').data;
  assert.equal(crew.payouts.status, 'active');
  assert.equal(crew.payouts.last4, '6789');
  assert.equal(crew.name, 'Jay Smith', 'rest of the doc is kept');
});
