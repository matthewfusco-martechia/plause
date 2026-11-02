import { describe, expect, it, vi } from 'vitest';
import { getConversationView, getWebConversation, setConversationMode } from '../apps/api/src/store';
import { encryptText } from '../packages/security/src/index';
import { testEnv } from './setup';

describe('customer conversation reads fence held decryption', () => {
  it.each(['erased', 'disabled', 'context', 'ownership', 'restore'] as const)('returns no captured private text after %s changes', async (change) => {
    const conversationId = await getWebConversation(testEnv, 'u_alex');
    const text = 'Fictional private text held during authorized decryption.';
    await testEnv.DB.prepare(`INSERT INTO messages(id,conversation_id,role,body_ciphertext,status,created_at)
      VALUES (?,?,'user',?,'received',?)`).bind(crypto.randomUUID(), conversationId, await encryptText(text, testEnv.CONTENT_ENCRYPTION_KEY), Date.now()).run();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
    const pending = getConversationView(testEnv, 'u_alex', conversationId);
    try {
      await ready;
      if (change === 'erased') await testEnv.DB.prepare("DELETE FROM users WHERE id='u_alex'").run();
      else if (change === 'disabled') await testEnv.DB.prepare("UPDATE users SET status='disabled',context_revision=context_revision+1 WHERE id='u_alex'").run();
      else if (change === 'context') await testEnv.DB.prepare("UPDATE users SET context_revision=context_revision+1 WHERE id='u_alex'").run();
      else if (change === 'restore') await testEnv.DB.prepare("INSERT INTO system_settings(key,value) VALUES('restore_locked','true')").run();
      else await setConversationMode(testEnv, 'u_alex', conversationId, 'human');
      release();
      if (change === 'erased' || change === 'disabled') expect(await pending).toBeNull();
      else if (change === 'restore') await expect(pending).rejects.toMatchObject({ status: 503, code: 'restore_locked' });
      else await expect(pending).rejects.toMatchObject({ status: 409, code: 'conversation_changed' });
    } finally { release(); spy.mockRestore(); }
  });
});
