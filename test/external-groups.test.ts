import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Minimal D1 stub: answers the three queries the external group routes issue.
function createDB(rows: Record<string, unknown>[][] = []) {
  let call = 0;
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: rows[call++] ?? [] })),
    first: vi.fn(async () => (rows[call++] ?? [null])[0] ?? null),
    run: vi.fn(async () => ({ meta: { last_row_id: 1 } })),
  };
  return { prepare: vi.fn(() => stmt), batch: vi.fn(async () => []), _stmt: stmt };
}

const API_KEY = 'test-key';

function buildApp(db: ReturnType<typeof createDB>) {
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import('../src/routes/external').then(({ default: external }: any) => {
    app.route('/api/external', external);
    return { app, env: { DB: db } as never };
  });
}

describe('external group API', () => {
  it('rejects a request without the API key', async () => {
    const db = createDB([[{ value: API_KEY }]]);
    const { app, env } = await buildApp(db);
    const res = await app.request('/api/external/groups', {}, env);
    expect(res.status).toBe(401);
  });

  it('lists groups with account counts', async () => {
    const groups = [
      { id: 1, name: '默认分组', account_count: 5 },
      { id: 7, name: 'ozon', account_count: 2 },
    ];
    const db = createDB([[{ value: API_KEY }], groups]);
    const { app, env } = await buildApp(db);
    const res = await app.request('/api/external/groups', { headers: { 'X-API-Key': API_KEY } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { name: string }[] };
    expect(body.success).toBe(true);
    expect(body.data.map((g) => g.name)).toEqual(['默认分组', 'ozon']);
  });

  it('lists the mailboxes of one group without any token material', async () => {
    const accounts = [
      { id: 41, email: 'fresh1@outlook.com', group_id: 7, group_name: 'ozon', status: 'active' },
    ];
    const db = createDB([[{ value: API_KEY }], accounts]);
    const { app, env } = await buildApp(db);
    const res = await app.request(
      '/api/external/accounts?group_id=7&status=active',
      { headers: { 'X-API-Key': API_KEY } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Record<string, unknown>[] } };
    expect(body.data.items[0].email).toBe('fresh1@outlook.com');
    expect(body.data.items[0]).not.toHaveProperty('refresh_token');
    expect(body.data.items[0]).not.toHaveProperty('client_id');
  });

  it('moves a mailbox into the default group after a successful registration', async () => {
    const db = createDB([
      [{ value: API_KEY }], // settings: external_api_key
      [{ id: 1, name: '默认分组' }], // groups lookup
      [{ id: 41, email: 'fresh1@outlook.com', group_id: 7 }], // accounts lookup
    ]);
    const { app, env } = await buildApp(db);
    const res = await app.request(
      '/api/external/groups/move',
      {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'fresh1@outlook.com', group_id: 1 }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { group_id: number }; message?: string };
    expect(body.data.group_id).toBe(1);
    expect(body.message).toContain('默认分组');
  });

  it('rejects a move without group_id', async () => {
    const db = createDB([[{ value: API_KEY }]]);
    const { app, env } = await buildApp(db);
    const res = await app.request(
      '/api/external/groups/move',
      {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@outlook.com' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});
