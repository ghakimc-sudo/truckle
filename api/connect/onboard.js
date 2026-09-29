// POST /api/connect/onboard  { workspaceId, kind: 'crew'|'company', id }
// Creates (once) a Stripe Connect Express account for a crew member or company
// and returns a Stripe-hosted onboarding link (ID, ABN, bank details).
import { admin, stripe, route, json, readJson, requireUser, requireMember, origin, getDoc, partyPath, HttpError } from '../_lib.js';

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { workspaceId, kind, id } = await readJson(request);
  await requireMember(user, workspaceId);
  if (!['crew', 'company'].includes(kind) || !id) throw new HttpError(400, 'Missing who is setting up payouts.');
  const [coll, docId] = partyPath(kind, id);
  const party = await getDoc(workspaceId, coll, docId);
  if (!party && kind === 'crew') throw new HttpError(404, 'Worker not found.');

  const db = admin(), s = stripe();
  const { data: row, error } = await db.from('connect_accounts').select('stripe_account_id')
    .eq('workspace_id', workspaceId).eq('party_kind', kind).eq('party_id', id).maybeSingle();
  if (error) throw error;

  let acct = row?.stripe_account_id;
  if (!acct) {
    const email = (party && party.email) || (kind === 'crew' ? undefined : user.email) || undefined;
    const a = await s.accounts.create({
      country: 'AU',
      email,
      business_type: kind === 'crew' ? 'individual' : undefined,
      controller: {
        stripe_dashboard: { type: 'express' },
        fees: { payer: 'application' },
        losses: { payments: 'application' },
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { mcc: '4214', product_description: kind === 'crew' ? 'Removalist labour' : 'Removals and moving services' },
      metadata: { truckle_workspace: workspaceId, truckle_kind: kind, truckle_id: id },
    });
    acct = a.id;
    const { error: e2 } = await db.from('connect_accounts').insert({
      workspace_id: workspaceId, party_kind: kind, party_id: id, stripe_account_id: acct, livemode: !!a.livemode,
    });
    if (e2) throw e2;
  }

  const base = origin(request);
  const back = `${base}/?connect=return&kind=${kind}&id=${encodeURIComponent(id)}`;
  const link = await s.accountLinks.create({
    account: acct,
    type: 'account_onboarding',
    return_url: back,
    refresh_url: `${base}/?connect=refresh&kind=${kind}&id=${encodeURIComponent(id)}`,
    collection_options: { fields: 'eventually_due' },
  });
  return json({ url: link.url, accountId: acct });
});
