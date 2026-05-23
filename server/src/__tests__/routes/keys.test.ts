import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys accepts direct openai, anthropic, kimi, and deepseek providers', async () => {
    const deepseek = await request(app, 'POST', '/api/keys', {
      platform: 'deepseek',
      key: 'sk-deepseek-test',
    });
    const kimi = await request(app, 'POST', '/api/keys', {
      platform: 'kimi',
      key: 'sk-kimi-test',
    });
    const openai = await request(app, 'POST', '/api/keys', {
      platform: 'openai',
      key: 'sk-openai-test',
    });
    const anthropic = await request(app, 'POST', '/api/keys', {
      platform: 'anthropic',
      key: 'sk-ant-test',
    });

    expect(deepseek.status).toBe(201);
    expect(deepseek.body.platform).toBe('deepseek');
    expect(kimi.status).toBe(201);
    expect(kimi.body.platform).toBe('kimi');
    expect(openai.status).toBe(201);
    expect(openai.body.platform).toBe('openai');
    expect(anthropic.status).toBe(201);
    expect(anthropic.body.platform).toBe('anthropic');
  });

  it('POST /api/keys/import validates new keys and prunes invalid ones', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('api.deepseek.com/models')) {
        return { ok: true, status: 200 } as any;
      }
      if (target.includes('api.moonshot.ai/v1/models')) {
        return { ok: false, status: 401 } as any;
      }
      if (target.includes('api.openai.com/v1/models')) {
        return { ok: false, status: 401 } as any;
      }
      if (target.includes('api.anthropic.com/v1/models')) {
        return { ok: true, status: 200 } as any;
      }
      return { ok: true, status: 200 } as any;
    });

    const { status, body } = await request(app, 'POST', '/api/keys/import', {
      entries: [
        { platform: 'deepseek', key: 'sk-deepseek-test', label: 'DeepSeek good' },
        { platform: 'kimi', key: 'sk-kimi-test', label: 'Kimi bad' },
        { platform: 'openai', key: 'sk-openai-test', label: 'OpenAI bad' },
        { platform: 'anthropic', key: 'sk-anthropic-test', label: 'Anthropic good' },
      ],
      validate: true,
      pruneInvalid: true,
    });

    expect(status).toBe(201);
    expect(body.healthy).toBe(2);
    expect(body.invalid).toBe(2);
    expect(body.removed).toBe(2);
    expect(body.results).toHaveLength(4);
    expect(body.results.find((r: any) => r.platform === 'deepseek').kept).toBe(true);
    expect(body.results.find((r: any) => r.platform === 'kimi').kept).toBe(false);
    expect(body.results.find((r: any) => r.platform === 'openai').kept).toBe(false);

    const after = await request(app, 'GET', '/api/keys');
    expect(after.body).toHaveLength(2);
    expect(after.body.map((row: any) => row.platform).sort()).toEqual(['anthropic', 'deepseek']);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });
});
