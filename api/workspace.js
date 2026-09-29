// POST /api/workspace  { role, name, join? }   (Authorization: Bearer <supabase token>)
// Finds the signed-in user's workspace, joins one via invite code, or creates one.
import { admin, route, json, readJson, requireUser, putDoc, HttpError } from './_lib.js';

const ROLES = ['company', 'crew', 'customer'];

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const body = await readJson(request);
  const role = ROLES.includes(body.role) ? body.role : null;
  const name = String(body.name || '').trim().slice(0, 80);
  const join = String(body.join || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 32);
  const db = admin();

  // Joining with an invite code always wins, so a worker who already has a
  // personal workspace can still join their company's.
  if (join) {
    const { data: ws, error } = await db.from('workspaces').select('id, name, join_code').eq('join_code', join).maybeSingle();
    if (error) throw error;
    if (!ws) throw new HttpError(404, 'That invite link is not valid any more. Ask for a new one.');
    const { data: had } = await db.from('workspace_members').select('role').eq('workspace_id', ws.id).eq('user_id', user.id).maybeSingle();
    if (!had) {
      const { error: e2 } = await db.from('workspace_members')
        .insert({ workspace_id: ws.id, user_id: user.id, role: role || 'crew', display_name: name });
      if (e2) throw e2;
    }
    return json({ workspaceId: ws.id, role: had?.role || role || 'crew', joinCode: ws.join_code, name: ws.name, joined: !had });
  }

  const { data: mine, error: e1 } = await db.from('workspace_members')
    .select('workspace_id, role, created_at, workspaces(join_code, name)')
    .eq('user_id', user.id).order('created_at', { ascending: true });
  if (e1) throw e1;
  if (mine && mine.length) {
    const m = mine.find((x) => x.role === role) || mine[0];
    return json({ workspaceId: m.workspace_id, role: m.role, joinCode: m.workspaces?.join_code, name: m.workspaces?.name });
  }

  if (!role) throw new HttpError(400, 'Pick how you will use Truckle.');
  const wsName = role === 'company' ? (name ? `${name}'s company` : 'My company') : (name || user.email || 'Me');
  const { data: ws, error: e3 } = await db.from('workspaces').insert({ name: wsName, owner: user.id }).select('id, join_code, name').single();
  if (e3) throw e3;
  const { error: e4 } = await db.from('workspace_members').insert({ workspace_id: ws.id, user_id: user.id, role, display_name: name });
  if (e4) throw e4;
  if (role === 'company') await putDoc(ws.id, 'settings', 'org', { name: '', email: user.email || '' });
  return json({ workspaceId: ws.id, role, joinCode: ws.join_code, name: ws.name, created: true });
});
