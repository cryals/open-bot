import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import type { Store } from './store.js';
import { HttpError } from './errors.js';
import { z } from 'zod';
const credentialSchema = z.object({
  accessToken: z
    .string()
    .min(1)
    .max(10000)
    .regex(/^[\x21-\x7e]+$/),
  refreshToken: z
    .string()
    .min(1)
    .max(10000)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  expiresAt: z.number().int().optional(),
  scopes: z.array(z.string()).optional(),
});
export type Credentials = z.infer<typeof credentialSchema>;
export class IntegrationVault {
  constructor(private store: Store) {}
  private key() {
    const input = process.env.INTEGRATION_KEY;
    if (!input || Buffer.from(input, 'base64').length !== 32)
      throw new HttpError(503, 'Для подключений задайте INTEGRATION_KEY: 32 случайных байта в base64');
    return Buffer.from(input, 'base64');
  }
  save(provider: string, account: string, document: unknown) {
    const parsed = credentialSchema.parse(document),
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(provider + ':' + account));
    const data = Buffer.concat([cipher.update(JSON.stringify(parsed)), cipher.final()]);
    this.store.sqlite
      .prepare(
        'INSERT INTO integration_credentials(provider,account,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(provider,account) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at',
      )
      .run(
        provider,
        account,
        JSON.stringify({
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: data.toString('base64'),
        }),
        Date.now(),
      );
  }
  get(provider: string, account: string): Credentials | null {
    return this.read(provider, account)?.credentials || null;
  }
  read(
    provider: string,
    account: string,
  ): { credentials: Credentials; fingerprint: string; account: string } | null {
    const row = this.store.sqlite
      .prepare('SELECT encrypted FROM integration_credentials WHERE provider=? AND account=?')
      .get(provider, account) as { encrypted: string } | undefined;
    if (!row) return null;
    const saved = JSON.parse(row.encrypted) as { iv: string; tag: string; data: string },
      cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(saved.iv, 'base64'));
    cipher.setAAD(Buffer.from(provider + ':' + account));
    cipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
    const credentials = credentialSchema.parse(
      JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(saved.data, 'base64')), cipher.final()]).toString(),
      ),
    );
    return { credentials, fingerprint: createHash('sha256').update(row.encrypted).digest('hex'), account };
  }
  remove(provider: string, account: string) {
    this.store.sqlite
      .prepare('DELETE FROM integration_credentials WHERE provider=? AND account=?')
      .run(provider, account);
  }
  list() {
    return this.store.sqlite.prepare('SELECT provider,account,updated_at FROM integration_credentials').all();
  }
  saveIfUnchanged(provider: string, account: string, fingerprint: string, document: unknown) {
    return this.store.sqlite
      .transaction(() => {
        const current = this.read(provider, account);
        if (!current) throw new HttpError(409, 'Подключение удалено во время обновления токена');
        if (current.fingerprint === fingerprint) this.save(provider, account, document);
        return this.get(provider, account)!;
      })
      .immediate();
  }
}
