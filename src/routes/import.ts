import { Hono } from 'hono';
import type { Env } from '../types';
import { batchRun } from '../db';
import { badRequest, fail, ok } from '../response';
import { isValidEmail } from '../utils/validation';

const importRoutes = new Hono<{ Bindings: Env }>();

const MAX_IMPORT_BODY_CHARS = 1_000_000;
const MAX_IMPORT_ACCOUNTS = 100;

type ImportBody = {
  account_string?: unknown;
  group_id?: unknown;
  remark?: unknown;
};

type ImportAccount = {
  email: string;
  password: string;
  clientId: string;
  refreshToken: string;
};

// Keep the import key out of query strings so it does not leak through URLs or access logs.
function sameSecret(provided: string, configured: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(configured);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

async function readBody(c: { req: { header(name: string): string | undefined; json<T>(): Promise<T>; text(): Promise<string> } }): Promise<ImportBody | null> {
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return await c.req.json<ImportBody>();
    } catch {
      return null;
    }
  }

  return { account_string: await c.req.text() };
}

function parseAccounts(accountString: string): { records: ImportAccount[]; invalid: number; total: number } {
  const lines = accountString
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const records: ImportAccount[] = [];
  let invalid = 0;

  for (const line of lines) {
    const parts = line.split('----');
    if (parts.length < 4) {
      invalid += 1;
      continue;
    }

    const email = parts[0].trim();
    const password = parts[1].trim();
    const clientId = parts[2].trim();
    // Preserve the delimiter if a future token format happens to contain it.
    const refreshToken = parts.slice(3).join('----').trim();

    if (!isValidEmail(email) || !clientId || !refreshToken) {
      invalid += 1;
      continue;
    }

    records.push({ email, password, clientId, refreshToken });
  }

  return { records, invalid, total: lines.length };
}

// POST /api/import/accounts
// Authentication: X-Import-Key backed by the ACCOUNT_IMPORT_API_KEY Worker secret.
// Body: text/plain with one account per line, or JSON { account_string, group_id?, remark? }.
importRoutes.post('/accounts', async (c) => {
  const configuredKey = c.env.ACCOUNT_IMPORT_API_KEY?.trim();
  if (!configuredKey) {
    return fail('IMPORT_DISABLED', '账号导入 API 未启用：请配置 ACCOUNT_IMPORT_API_KEY', 503);
  }

  const providedKey = c.req.header('X-Import-Key')?.trim() || '';
  if (!sameSecret(providedKey, configuredKey)) {
    return fail('UNAUTHORIZED', '导入 API Key 无效', 401);
  }

  const body = await readBody(c);
  if (!body || typeof body.account_string !== 'string') {
    return badRequest('account_string 必须是文本');
  }
  if (body.account_string.length > MAX_IMPORT_BODY_CHARS) {
    return fail('PAYLOAD_TOO_LARGE', '单次导入内容不能超过 1 MB', 413);
  }

  const rawGroupId = body.group_id ?? 1;
  const groupId = typeof rawGroupId === 'number' ? rawGroupId : Number(rawGroupId);
  if (!Number.isInteger(groupId) || groupId < 1) {
    return badRequest('group_id 必须是正整数');
  }

  const remark = body.remark === undefined ? '' : String(body.remark).trim();
  const parsed = parseAccounts(body.account_string);
  if (parsed.total > MAX_IMPORT_ACCOUNTS) {
    return fail('TOO_MANY_ACCOUNTS', `单次最多导入 ${MAX_IMPORT_ACCOUNTS} 个账号`, 413);
  }
  if (parsed.records.length === 0) {
    return badRequest('没有有效账号；格式应为 邮箱----密码----client_id----refresh_token');
  }

  const results = await batchRun(
    c.env.DB,
    parsed.records.map((account) => ({
      sql: `INSERT OR IGNORE INTO accounts
            (email, password, client_id, refresh_token, group_id, remark)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [account.email, account.password, account.clientId, account.refreshToken, groupId, remark],
    }))
  );

  const imported = results.reduce((count, result) => count + Number(result.meta.changes || 0), 0);
  const skipped = parsed.records.length - imported;

  return ok(
    {
      total: parsed.total,
      imported,
      skipped,
      invalid: parsed.invalid,
    },
    `导入完成：新增 ${imported} 个，跳过 ${skipped} 个，无效 ${parsed.invalid} 个`
  );
});

export default importRoutes;
