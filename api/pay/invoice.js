// GET /api/pay/invoice?w=<workspace>&i=<invoice>
// Public, read-only view of one customer invoice for the pay-link page.
// Needs both ids, so it can't be used to list or guess other invoices.
import { admin, route, json, getDoc, companyPath, custInvoiceQuote, CUST_METHODS, HttpError, isUuid } from '../_lib.js';

export const GET = route(async (request) => {
  const u = new URL(request.url);
  const ws = u.searchParams.get('w'), id = u.searchParams.get('i');
  if (!isUuid(ws) || !id) throw new HttpError(400, 'This pay link is incomplete.');
  const c = await getDoc(ws, 'cinvoices', id);
  if (!c) throw new HttpError(404, 'We could not find this invoice. Ask the company to send the link again.');
  const coId = c.companyId || 'org';
  const [cc, cd] = companyPath(coId);
  const co = (await getDoc(ws, cc, cd)) || {};
  const { data: acct } = await admin().from('connect_accounts').select('charges_enabled')
    .eq('workspace_id', ws).eq('party_kind', 'company').eq('party_id', coId).maybeSingle();
  return json({
    number: c.number, customer: c.customer, total: +c.total || 0, gst: +c.gst || 0, gstIncl: !!c.gstIncl,
    lines: (c.lines || []).map((l) => ({ desc: l.desc, amount: +l.amount || 0 })),
    notes: c.notes || '', issuedAt: c.issuedAt, dueAt: c.dueAt,
    status: c.status, paidAt: c.paidAt || null, paidBy: c.payment?.label || null,
    processing: c.payment?.status === 'processing',
    company: { name: co.name || 'Your removalist', phone: co.phone || '', abn: co.abn || '' },
    canPay: !!acct?.charges_enabled,
    methods: Object.entries(CUST_METHODS).map(([k, m]) => ({ id: k, label: m.label })),
    fees: Object.fromEntries(Object.keys(CUST_METHODS).map((k) => [k, custInvoiceQuote(+c.total || 0, k).fee])),
  });
});
