// Applies a finished Stripe payment to the app's data: marks the invoice paid,
// writes the receipt details, posts the chat message and sends notifications,
// in the same shapes the app's own payInApp()/cpayNow code uses.
import {
  admin, getDoc, patchDoc, companyPath, notify, postMsg, chatKey, invCo,
  crewBillQuote, custInvoiceQuote, todayAU, bizDays, money,
} from '../_lib.js';

export async function settle(session, outcome) {
  const m = session.metadata || {};
  const ws = m.truckle_workspace, kind = m.truckle_kind, id = m.truckle_id, method = m.truckle_method;
  if (!ws || !kind || !id) return 'ignored: not a Truckle checkout';
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null;
  const now = new Date().toISOString(), today = todayAU();

  await admin().from('payments')
    .update({ status: outcome, payment_intent_id: pi, updated_at: now })
    .eq('checkout_session_id', session.id);

  const coll = kind === 'invoice' ? 'invoices' : 'cinvoices';
  const doc = await getDoc(ws, coll, id);
  if (!doc) return 'ignored: invoice gone';
  if (doc.status === 'paid') return 'ignored: already paid';

  if (kind === 'invoice') {
    const q = crewBillQuote(+doc.total || 0, method);
    const [cc, cd] = companyPath(invCo(doc));
    const co = (await getDoc(ws, cc, cd)) || {};
    const crew = (await getDoc(ws, 'crew', doc.crewId)) || {};
    const payment = {
      via: 'stripe', method, label: q.label, processingFee: q.proc, platformFee: q.plat,
      charged: r(session.amount_total, q.charged), payout: q.payout, ref: pi, session: session.id,
      at: now, testMode: !session.livemode,
    };
    if (outcome === 'processing') {
      await patchDoc(ws, coll, id, {
        payment: { ...payment, status: 'processing' },
        history: [...(doc.history || []), { t: now, what: `${q.label} payment started (clears in 2 to 3 business days)`, who: co.name || 'Company' }],
      });
      return 'invoice processing';
    }
    if (outcome === 'failed') {
      await patchDoc(ws, coll, id, {
        payment: { ...payment, status: 'failed' },
        history: [...(doc.history || []), { t: now, what: `${q.label} payment failed`, who: 'Stripe' }],
      });
      await notify(ws, 'company', invCo(doc) || 'org', 'overdue', `Payment to ${crew.name || 'crew'} failed`, `${doc.number} · try another way to pay`, id);
      return 'invoice failed';
    }
    const eta = bizDays(today, method === 'becs' ? 3 : 1);
    const hist = [...(doc.history || [])];
    if (doc.status !== 'approved') hist.push({ t: now, what: 'Approved', who: co.name || 'Company' });
    hist.push({ t: now, what: `Paid in Truckle by ${q.label} (${pi})`, who: co.name || 'Company' });
    await patchDoc(ws, coll, id, {
      status: 'paid', paidAt: today, paidRef: pi, approvedAt: doc.approvedAt || now,
      payment: { ...payment, status: 'succeeded', payoutEta: eta }, history: hist,
    });
    await postMsg(ws, chatKey(invCo(doc), doc.crewId), 'company', `Paid ${doc.number} · ${money(doc.total)} in Truckle · lands in your account ${eta}`, { kind: 'paid' });
    await notify(ws, 'crew', doc.crewId, 'paid', `${co.name || 'Your company'} paid you ${money(doc.total)}`, `${doc.number} · arriving in your account by ${eta}`, id);
    await notify(ws, 'company', invCo(doc) || 'org', 'paid', `Payment sent · ${money(payment.charged)}`, `${doc.number} to ${crew.name || 'crew'} · receipt ${pi}`, id);
    return 'invoice paid';
  }

  // Customer invoice
  const q = custInvoiceQuote(+doc.total || 0, method);
  const payment = {
    via: 'stripe', method, label: q.label, fee: q.fee, plat: q.plat, net: q.net, ref: pi,
    session: session.id, at: now, testMode: !session.livemode,
  };
  if (outcome === 'processing') {
    await patchDoc(ws, coll, id, { payment: { ...payment, status: 'processing' }, history: [...(doc.history || []), { t: now, what: `${q.label} payment started`, who: doc.customer || 'Customer' }] });
    return 'cinvoice processing';
  }
  if (outcome === 'failed') {
    await patchDoc(ws, coll, id, { payment: { ...payment, status: 'failed' }, history: [...(doc.history || []), { t: now, what: `${q.label} payment failed`, who: 'Stripe' }] });
    await notify(ws, 'company', doc.companyId || 'org', 'overdue', `${doc.customer || 'Customer'}'s payment failed`, `${doc.number} · ${money(doc.total)}`, null, doc.jobId || null);
    return 'cinvoice failed';
  }
  await patchDoc(ws, coll, id, {
    status: 'paid', paidAt: today, payment: { ...payment, status: 'succeeded' },
    history: [...(doc.history || []), { t: now, what: 'Paid by ' + q.label, who: doc.customer || 'Customer' }],
  });
  await notify(ws, 'company', doc.companyId || 'org', 'paid', `${doc.customer || 'Customer'} paid ${money(doc.total)}`, `${doc.number} · ${money(q.net)} on its way to your bank`, null, doc.jobId || null);
  return 'cinvoice paid';
}

const r = (amountCents, fallback) => (Number.isFinite(amountCents) ? amountCents / 100 : fallback);

