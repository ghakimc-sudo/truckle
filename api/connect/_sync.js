import { admin, patchDoc, putDoc, getDoc, partyPath } from '../_lib.js';

// Mirror a Stripe account onto connect_accounts and the party's doc.
// Returns the `payouts` object stored on the doc (or null if unknown account).
export async function syncAccount(acct) {
  const db = admin();
  const { data: row, error } = await db.from('connect_accounts')
    .update({
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_account_id', acct.id)
    .select('workspace_id, party_kind, party_id').maybeSingle();
  if (error) throw error;
  if (!row) return null;

  const bank = (acct.external_accounts?.data || []).find((x) => x.object === 'bank_account') || null;
  const ready = !!(acct.charges_enabled && acct.payouts_enabled);
  const due = acct.requirements?.currently_due || [];
  const payouts = {
    status: ready ? 'active' : acct.details_submitted ? 'review' : 'pending',
    provider: 'stripe',
    accountId: acct.id,
    testMode: !acct.livemode,
    bankName: bank?.bank_name || 'your bank',
    last4: bank?.last4 || '',
    needs: due.length,
    at: new Date().toISOString(),
  };
  const [coll, id] = partyPath(row.party_kind, row.party_id);
  if (await getDoc(row.workspace_id, coll, id)) await patchDoc(row.workspace_id, coll, id, { payouts });
  else await putDoc(row.workspace_id, coll, id, { payouts });
  return payouts;
}
