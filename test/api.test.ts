import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock D1 database
function createMockDB() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }),
  };
  return {
    prepare: vi.fn(() => mockStmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: mockStmt,
  };
}

// Test crypto utilities
describe('crypto utils', () => {
  it('hashPassword produces consistent hex output', async () => {
    // Web Crypto is available in vitest with happy-dom or jsdom
    const { hashPassword } = await import('../src/utils/crypto');
    const hash1 = await hashPassword('test123');
    const hash2 = await hashPassword('test123');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  it('hmacSign and hmacVerify roundtrip', async () => {
    const { hmacSign, hmacVerify } = await import('../src/utils/crypto');
    const secret = 'test-secret-key';
    const payload = 'admin:1234567890';
    const sig = await hmacSign(payload, secret);
    expect(sig).toMatch(/^[0-9a-f]+$/);
    const valid = await hmacVerify(payload, sig, secret);
    expect(valid).toBe(true);
    const invalid = await hmacVerify(payload, sig + 'x', secret);
    expect(invalid).toBe(false);
  });
});

// Test validation utilities
describe('validation utils', () => {
  it('isValidEmail accepts valid emails', async () => {
    const { isValidEmail } = await import('../src/utils/validation');
    expect(isValidEmail('user@outlook.com')).toBe(true);
    expect(isValidEmail('a.b@c.d')).toBe(true);
  });

  it('isValidEmail rejects invalid emails', async () => {
    const { isValidEmail } = await import('../src/utils/validation');
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-email')).toBe(false);
    expect(isValidEmail('@no-user.com')).toBe(false);
  });

  it('maskToken masks long strings', async () => {
    const { maskToken } = await import('../src/utils/validation');
    expect(maskToken('abcdefghijklmnop')).toBe('abcd****mnop');
    expect(maskToken('short')).toBe('****');
  });
});

// Test auth session
describe('auth session', () => {
  it('issueSessionCookie and verifySession roundtrip', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const secret = 'my-test-secret';
    const cookie = await issueSessionCookie(secret);
    expect(cookie).toContain('admin:');
    const valid = await verifySession(cookie, secret);
    expect(valid).toBe(true);
  });

  it('verifySession rejects tampered cookie', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const secret = 'my-test-secret';
    const cookie = await issueSessionCookie(secret);
    const tampered = cookie.slice(0, -4) + 'xxxx';
    const valid = await verifySession(tampered, secret);
    expect(valid).toBe(false);
  });

  it('verifySession rejects wrong secret', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const cookie = await issueSessionCookie('secret-a');
    const valid = await verifySession(cookie, 'secret-b');
    expect(valid).toBe(false);
  });
});

// Test response helpers
describe('response helpers', () => {
  it('ok returns success JSON', async () => {
    const { ok } = await import('../src/response');
    const res = ok({ id: 1 }, 'created');
    const body = await res.json() as { success: boolean; data: { id: number }; message: string };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(1);
    expect(body.message).toBe('created');
  });

  it('fail returns error JSON with status', async () => {
    const { fail } = await import('../src/response');
    const res = fail('NOT_FOUND', 'not found', 404);
    expect(res.status).toBe(404);
    const body = await res.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// Test password verification logic
describe('verifyPassword', () => {
  it('verifies against ADMIN_PASSWORD when no hash stored', async () => {
    const { verifyPassword } = await import('../src/auth');
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(null); // No hash in DB
    mockDB._stmt.run.mockResolvedValue({}); // Store hash

    const result = await verifyPassword(mockDB as any, 'admin123', 'admin123');
    expect(result).toBe(true);
  });

  it('rejects wrong password', async () => {
    const { verifyPassword } = await import('../src/auth');
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(null);

    const result = await verifyPassword(mockDB as any, 'wrong', 'admin123');
    expect(result).toBe(false);
  });
});

// Regression: saving a new refresh_token must clear a stale 'error' status
// (the error verdict referred to the old token), while a deliberate
// 'disabled' status must never be auto-changed.
describe('accounts route: status recovery on token update', () => {
  const baseAccount = {
    id: 5,
    email: 'a@b.c',
    password: '',
    client_id: 'cid',
    refresh_token: 'old-token',
    group_id: 1,
    remark: '',
    status: 'error',
  };

  async function putAccount(body: object, account: Record<string, unknown> = baseAccount) {
    const accountsRoute = (await import('../src/routes/accounts')).default;
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(account);
    const res = await accountsRoute.request(
      `/${account.id}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { DB: mockDB } as any
    );
    // The full UPDATE binds 8 params:
    // [email, password, client_id, refresh_token, group_id, remark, status, id]
    const updateCall = mockDB._stmt.bind.mock.calls.find((args) => args.length === 8);
    return { res, updateCall };
  }

  it('resets error to active when a new refresh_token is saved', async () => {
    const { res, updateCall } = await putAccount({ refresh_token: 'brand-new-token' });
    expect(res.status).toBe(200);
    expect(updateCall).toBeDefined();
    expect(updateCall![3]).toBe('brand-new-token');
    expect(updateCall![6]).toBe('active');
  });

  it('keeps error status when no new token is provided', async () => {
    const { updateCall } = await putAccount({ remark: 'note' });
    expect(updateCall![6]).toBe('error');
  });

  it('does not re-enable a disabled account on token save', async () => {
    const { updateCall } = await putAccount(
      { refresh_token: 'brand-new-token' },
      { ...baseAccount, status: 'disabled' }
    );
    expect(updateCall![6]).toBe('disabled');
  });
});

describe('account import route', () => {
  async function postImport(
    body: string,
    options: { key?: string; configuredKey?: string; contentType?: string; batchChanges?: number[] } = {}
  ) {
    const importRoute = (await import('../src/routes/import')).default;
    const mockDB = createMockDB();
    mockDB.batch.mockResolvedValue(
      (options.batchChanges ?? [1]).map((changes) => ({ meta: { changes } }))
    );
    const env = {
      DB: mockDB,
      ACCOUNT_IMPORT_API_KEY: options.configuredKey ?? 'import-secret',
    };
    const res = await importRoute.request(
      '/accounts',
      {
        method: 'POST',
        headers: {
          'Content-Type': options.contentType ?? 'text/plain',
          ...(options.key === undefined ? {} : { 'X-Import-Key': options.key }),
        },
        body,
      },
      env as any
    );
    return { res, mockDB };
  }

  it('rejects requests when the import secret is not configured', async () => {
    const { res } = await postImport('a@b.com----pwd----cid----rt', { configuredKey: '' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'IMPORT_DISABLED' } });
  });

  it('rejects an invalid import key', async () => {
    const { res } = await postImport('a@b.com----pwd----cid----rt', { key: 'wrong' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('imports text lines and reports invalid rows and duplicates', async () => {
    const body = [
      'a@outlook.com----pwd----cid-a----rt-a',
      'not-an-email----pwd----cid-b----rt-b',
      'b@outlook.com----pwd----cid-b----rt-b',
    ].join('\n');
    const { res, mockDB } = await postImport(body, { key: 'import-secret', batchChanges: [1, 0] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { total: 3, imported: 1, skipped: 1, invalid: 1 },
    });
    expect(mockDB.batch).toHaveBeenCalledTimes(1);
    expect(mockDB.batch.mock.calls[0][0]).toHaveLength(2);
  });

  it('accepts the JSON form with group and remark', async () => {
    const payload = JSON.stringify({
      account_string: 'a@outlook.com----pwd----cid----rt',
      group_id: 2,
      remark: '自动注册',
    });
    const { res, mockDB } = await postImport(payload, {
      key: 'import-secret',
      contentType: 'application/json',
    });

    expect(res.status).toBe(200);
    expect(mockDB.prepare.mock.calls[0][0]).toContain('INSERT OR IGNORE INTO accounts');
    expect(mockDB._stmt.bind).toHaveBeenLastCalledWith(
      'a@outlook.com',
      'pwd',
      'cid',
      'rt',
      2,
      '自动注册',
    );
  });
});
