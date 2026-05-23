import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { checkKeyHealth } from '../services/health.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Hugging Face and MiniMax direct integrations were dropped in V4
// (see migrateModelsV4 comment block).
const PLATFORMS = [
  'google', 'deepseek', 'kimi', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'openai', 'anthropic', 'github', 'cohere', 'cloudflare',
  'zhipu', 'ollama', 'kilo', 'pollinations', 'llm7',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

const importKeysSchema = z.object({
  entries: z.array(addKeySchema).min(1).max(200),
  validate: z.boolean().optional(),
  pruneInvalid: z.boolean().optional(),
});

type AddKeyInput = z.infer<typeof addKeySchema>;

function insertKey({ platform, key, label }: AddKeyInput) {
  const { encrypted, iv, authTag } = encrypt(key);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  return {
    id: Number(result.lastInsertRowid),
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown' as const,
    enabled: true,
  };
}

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  res.status(201).json(insertKey(parsed.data));
});

// Bulk import provider keys and optionally validate them immediately.
keysRouter.post('/import', async (req: Request, res: Response) => {
  const parsed = importKeysSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { entries, validate = false, pruneInvalid = false } = parsed.data;
  const shouldValidate = validate || pruneInvalid;
  const db = getDb();
  const results: Array<{
    id: number;
    platform: typeof PLATFORMS[number];
    label: string;
    maskedKey: string;
    status: string;
    kept: boolean;
  }> = [];

  let healthy = 0;
  let invalid = 0;
  let errors = 0;
  let removed = 0;

  for (const entry of entries) {
    const created = insertKey(entry);
    let status = created.status as string;
    let kept = true;

    if (shouldValidate) {
      status = await checkKeyHealth(created.id);
      if (status === 'healthy') {
        healthy++;
      } else if (status === 'invalid') {
        invalid++;
        if (pruneInvalid) {
          db.prepare('DELETE FROM api_keys WHERE id = ?').run(created.id);
          kept = false;
          removed++;
        }
      } else {
        errors++;
      }
    }

    results.push({
      id: created.id,
      platform: created.platform,
      label: created.label,
      maskedKey: created.maskedKey,
      status,
      kept,
    });
  }

  res.status(201).json({
    totalSubmitted: entries.length,
    created: results.length,
    validated: shouldValidate ? results.length : 0,
    healthy,
    invalid,
    errors,
    removed,
    results,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true });
});

// Toggle enable/disable
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
