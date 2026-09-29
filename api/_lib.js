// Shared helpers for the Truckle API (Vercel Functions, Node runtime).
// Files starting with "_" are not deployed as their own endpoints.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const env = (k) => (process.env[k] || '').trim();

export const SUPABASE_URL = () => env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL');
export const SUPABASE_ANON_KEY = () => env('SUPABASE_ANON_KEY') || env('NEXT_PUBLIC_SUPABASE_ANON_KEY');

let _stripe = null;
export function stripe() {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new HttpError(503, 'Truckle Pay is not configured yet (STRIPE_SECRET_KEY missing).');
  if (key.startsWith('sk_live_') && env('TRUCKLE_ALLOW_LIVE') !== '1') {
    throw new HttpError(503, 'Live Stripe keys are blocked until TRUCKLE_ALLOW_LIVE=1 is set.');
  }
  if (!_stripe) _stripe = new Stripe(key, { appInfo: { name: 'Truckle' } });
  return _stripe;
}

let _admin = null;
export function admin() {
  const url = SUPABASE_URL(), key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new HttpError(503, 'Backend is not configured yet (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
  if (!_admin) _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// Wrap a handler so thrown HttpErrors become JSON responses.
export function route(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e && e.type && String(e.type).startsWith('Stripe')) {
        console.error('stripe error', e.type, e.code, e.message);
        return json({ error: e.message || 'Stripe error' }, 402);
      }
      console.error(e);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  };
}

export async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Expected a JSON body.'); }
}

export function origin(request) {
  const set = env('APP_URL');
  if (set) return set.replace(/\/$/, '');
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || u.host;
  const proto = request.headers.get('x-forwarded-proto') || u.protocol.replace(':', '');
  return `${proto}://${host}`;
}

// Resolve the signed-in Supabase user from "Authorization: Bearer <access token>".
export async function requireUser(request) {
  const h = request.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in first.');
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  return data.user;
}

export async function requireMember(user, workspaceId) {
  if (!isUuid(workspaceId)) throw new HttpError(400, 'Missing workspace.');
  const { data, error } = await admin().from('workspace_members')
    .select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(403, 'You are not part of this workspace.');
  return data;
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

// ---------------------------------------------------------------------------
// Docs (the app's JSON collections)
// ---------------------------------------------------------------------------
export async function getDoc(ws, coll, id) {
  const { data, error } = await admin().from('docs').select('data')
    .eq('workspace_id', ws).eq('coll', coll).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? data.data : null;
}

export async function patchDoc(ws, coll, id, patch) {
  const { data, error } = await admin().rpc('doc_patch', { p_ws: ws, p_coll: coll, p_id: id, p_patch: patch });
  if (error) throw error;
  return data;
}

export async function putDoc(ws, coll, id, doc) {
  const { error } = await admin().from('docs')
    .upsert({ workspace_id: ws, coll, id, data: doc, updated_at: new Date().toISOString(), updated_by: null });
  if (error) throw error;
}

// The company doc lives at settings/org for the main company, companies/<id> otherwise.
export const companyPath = (coId) => (!coId || coId === 'org') ? ['settings', 'org'] : ['companies', coId];
export const partyPath = (kind, id) => kind === 'crew' ? ['crew', id] : companyPath(id);

// ---------------------------------------------------------------------------
// Money. These mirror PAY / CPAY / platFee in index.html exactly, so the
// amount Stripe charges always matches what the app showed.
// ---------------------------------------------------------------------------
export const r2 = (n) => Math.round(n * 100) / 100;
export const cents = (n) => Math.round(r2(n) * 100);
const bankFee = (a) => Math.min(3.5, a * 0.01 + 0.3);
const cardFee = (a) => a * 0.017 + 0.3;
export const platFee = (a) => r2(Math.min(5, a * 0.005));

// Company pays a crew member's bill.
export const CREW_METHODS = {
  payto: { label: 'PayTo', fee: bankFee, types: ['payto'] },
  becs: { label: 'Direct debit (BECS)', fee: bankFee, types: ['au_becs_debit'] },
  card: { label: 'Business card', fee: cardFee, types: ['card'] },
};
// Customer pays a company's invoice.
export const CUST_METHODS = {
  card: { label: 'Card', fee: cardFee, types: ['card'] },
  wallet: { label: 'Apple Pay / Google Pay', fee: cardFee, types: ['card'] },
  payto: { label: 'Bank (PayTo)', fee: bankFee, types: ['payto'] },
};

// Crew bill: company pays total + processing + Truckle fee; crew receives the full total.
export function crewBillQuote(total, method) {
  const m = CREW_METHODS[method];
  if (!m) throw new HttpError(400, 'Unknown payment method.');
  const proc = r2(m.fee(total)), plat = platFee(total);
  return { label: m.label, types: m.types, proc, plat, charged: r2(total + proc + plat), payout: r2(total) };
}

// Customer invoice: customer pays the total; fees come out of what the company receives.
export function custInvoiceQuote(total, method) {
  const m = CUST_METHODS[method];
  if (!m) throw new HttpError(400, 'Unknown payment method.');
  const fee = r2(m.fee(total)), plat = platFee(total);
  return { label: m.label, types: m.types, fee, plat, charged: r2(total), net: r2(total - fee - plat) };
}

// ---------------------------------------------------------------------------
// Dates, in Sydney time to match what people see in the app.
// ---------------------------------------------------------------------------
export function todayAU(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function bizDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n--; }
  return d.toISOString().slice(0, 10);
}

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const money = (n) => '$' + (+n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// Same shape the app's notify() writes.
export async function notify(ws, toKind, toId, kind, title, body, invId = null, jobId = null) {
  if (!toId) return;
  await putDoc(ws, 'notes', uid(), { toKind, toId, kind, title, body: body || '', invId, jobId, t: new Date().toISOString(), read: false });
}

// Same shape the app's postMsg() writes.
export async function postMsg(ws, chatId, from, text, extra = {}) {
  const cur = await getDoc(ws, 'chats', chatId);
  const m = { id: uid(), from, text, t: new Date().toISOString(), ...extra };
  const messages = [...((cur && cur.messages) || []), m].slice(-300);
  const read = from === 'company' ? { readCompany: m.t } : { readCrew: m.t };
  if (cur) await patchDoc(ws, 'chats', chatId, { messages, ...read });
  else await putDoc(ws, 'chats', chatId, { messages, ...read });
}
export const chatKey = (co, cid) => (!co || co === 'org') ? cid : co + '__' + cid;
export const invCo = (i) => i.companyId || (i.clientId ? null : 'org');
