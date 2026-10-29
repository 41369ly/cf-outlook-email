import { Hono } from 'hono';
import type { Env, AccountRow, GroupRow } from '../types';
import { first, query, run } from '../db';
import { ok, fail, notFound, badRequest } from '../response';
import { getAccessToken, fetchEmails } from '../graph';

// External API: fetch emails by API key, no login required.
// Mounted BEFORE the cookie auth middleware so it is not gated by sessions.
const external = new Hono<{ Bindings: Env }>();

// API-key auth: accept `X-API-Key` header or `?key=` query param
external.use('*', async (c, next) => {
  const row = await first<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'external_api_key'",
    []
  );
  const configured = row?.value;
  if (!configured) {
    return fail('API_DISABLED', '对外 API 未启用：请在「系统设置」生成 API Key', 403);
  }
  const provided = c.req.header('X-API-Key') || c.req.query('key') || '';
  if (provided !== configured) {
    return fail('UNAUTHORIZED', 'API Key 无效', 401);
  }
  await next();
});

// GET /api/external/emails?email=<addr>&folder=inbox|junkemail|deleteditems|all&top=10&keyword=&includeBody=1
external.get('/emails', async (c) => {
  const email = (c.req.query('email') || '').trim().toLowerCase();
  if (!email) return fail('BAD_REQUEST', '缺少 email 参数', 400);

  const folder = c.req.query('folder') || 'inbox';
  const top = Math.min(parseInt(c.req.query('top') || '10', 10) || 10, 50);
  const keyword = c.req.query('keyword') || undefined;
  // bodyPreview is truncated to 255 chars by Graph; includeBody=1 adds the full plain-text body
  const includeBody = ['1', 'true'].includes((c.req.query('includeBody') || '').toLowerCase());

  const acc = await first<AccountRow>(
    c.env.DB,
    'SELECT * FROM accounts WHERE lower(email) = ?',
    [email]
  );
  if (!acc) return fail('NOT_FOUND', '账号不存在', 404);
  if (acc.status === 'disabled') return fail('DISABLED', '该账号已停用', 400);

  const tok = await getAccessToken(acc.client_id, acc.refresh_token);
  if (!tok.token) {
    await run(c.env.DB, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
    return fail('TOKEN_FAILED', tok.error?.message || 'Token 获取失败', 502);
  }
  // Persist a rotated refresh_token if Microsoft issued one
  if (tok.newRefreshToken && tok.newRefreshToken !== acc.refresh_token) {
    await run(
      c.env.DB,
      "UPDATE accounts SET refresh_token = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [tok.newRefreshToken, acc.id]
    );
  } else if (acc.status === 'error') {
    // Token works without rotation: clear the stale error flag
    await run(c.env.DB, "UPDATE accounts SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
  }

  const result = await fetchEmails(tok.token, { folder, top, skip: 0, keyword, includeBody });
  if (result.error) return fail('GRAPH_ERROR', result.error.message, 502);

  const items = (result.items ?? []).map((e) => ({
    id: e.id,
    subject: e.subject ?? '(无主题)',
    from: {
      name: e.from?.emailAddress?.name ?? '',
      address: e.from?.emailAddress?.address ?? '',
    },
    receivedDateTime: e.receivedDateTime,
    bodyPreview: e.bodyPreview ?? '',
    ...(includeBody ? { body: e.body?.content ?? '' } : {}),
    isRead: e.isRead,
  }));

  return ok({ email, folder, count: items.length, items });
});

// GET /api/external/groups
// 分组列表（含账号数）。给自动化脚本用：先查分组，再按 group_id 取号。
external.get('/groups', async (c) => {
  const rows = await query<GroupRow & { account_count: number }>(
    c.env.DB,
    `SELECT g.*, (SELECT COUNT(*) FROM accounts a WHERE a.group_id = g.id) AS account_count
     FROM groups g ORDER BY g.id`
  );
  return ok(rows);
});

// GET /api/external/accounts?group_id=<id>&status=active&keyword=&limit=
// 账号列表（不含 token），用于从指定分组里挑一个还没用过的邮箱。
external.get('/accounts', async (c) => {
  const groupId = c.req.query('group_id');
  const status = c.req.query('status');
  const keyword = c.req.query('keyword');
  const limitRaw = parseInt(c.req.query('limit') || '200', 10);
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200, 500);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (groupId) {
    conditions.push('a.group_id = ?');
    params.push(parseInt(groupId, 10));
  }
  if (status) {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (keyword) {
    conditions.push('a.email LIKE ?');
    params.push(`%${keyword}%`);
  }

  let sql = `SELECT a.id, a.email, a.group_id, g.name AS group_name, a.status, a.remark,
                    a.created_at, a.updated_at
             FROM accounts a LEFT JOIN groups g ON a.group_id = g.id`;
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY a.created_at ASC LIMIT ?';
  params.push(limit);

  const rows = await query<Record<string, unknown>>(c.env.DB, sql, params);
  return ok({ count: rows.length, items: rows });
});

// POST /api/external/groups/move  body: { email | account_id, group_id }
// 把邮箱挪到另一个分组：注册成功后把 ozon 分组的邮箱移回默认分组。
external.post('/groups/move', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    account_id?: number;
    group_id?: number;
  };
  const targetGroup = Number(body.group_id);
  if (!Number.isInteger(targetGroup)) return badRequest('group_id 必须是整数');

  const group = await first<GroupRow>(c.env.DB, 'SELECT * FROM groups WHERE id = ?', [targetGroup]);
  if (!group) return notFound('目标分组不存在');

  let acc: AccountRow | null = null;
  if (body.account_id !== undefined) {
    acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [Number(body.account_id)]);
  } else if (body.email) {
    acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE lower(email) = ?', [
      body.email.trim().toLowerCase(),
    ]);
  } else {
    return badRequest('需要 email 或 account_id');
  }
  if (!acc) return notFound('账号不存在');

  await run(c.env.DB, 'UPDATE accounts SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    targetGroup,
    acc.id,
  ]);
  return ok(
    { id: acc.id, email: acc.email, group_id: targetGroup, group_name: group.name },
    `已移动到分组「${group.name}」`
  );
});

export default external;
