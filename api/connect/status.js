// POST /api/connect/status  { workspaceId, kind, id }
// Pulls the latest state of a Connect account from Stripe and writes it onto
// the crew/company doc so the app shows "Payouts on". The webhook does the
// same on account.updated; this makes the return from onboarding instant.
import { stripe, route, json, readJson, requireUser, requireMember, admin, HttpError } from '../_lib.js';
import { syncAccount } from './_sync.js';

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { workspaceId, kind, id } = await readJson(request);
  await requireMember(user, workspaceId);
  const { data: row, error } = await admin().from('connect_accounts').select('stripe_account_id')
    .eq('workspace_id', workspaceId).eq('party_kind', kind).eq('party_id', id).maybeSingle();
  if (error) throw error;
  if (!row) throw new HttpError(404, 'Payouts have not been started yet.');
  const acct = await stripe().accounts.retrieve(row.stripe_account_id);
  const payouts = await syncAccount(acct);
  return json({ payouts });
});
