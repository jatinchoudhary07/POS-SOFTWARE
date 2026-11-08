import { Router } from 'express';
import { z } from 'zod';
import { requireRole, requireSession } from '../lib/auth';
import type { PushService } from '../services/pushService';

/**
 * Only the real push services of the phone makers are accepted as a device address, so nobody can make
 * this server send requests to other places by "subscribing" with a made-up address.
 */
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const isPushAddress = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
};

const subscribeSchema = z
  .object({
    endpoint: z.string().max(2000).refine(isPushAddress, 'Not a push service address'),
    keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(10).max(100) }).strict(),
  })
  .strict();
const unsubscribeSchema = z.object({ endpoint: z.string().max(2000) }).strict();

const anyone = requireRole('SUPERADMIN', 'RECEPTION', 'KITCHEN');

/** /api/push - alerts that reach a phone while its screen is locked or the app is in the background. */
export function pushRouter(push: PushService): Router {
  const router = Router();

  // The public key the phone needs to subscribe. `enabled: false` when this server has no keys.
  router.get('/key', anyone, (_req, res) => {
    res.json({ enabled: push.enabled, publicKey: push.publicKey });
  });

  router.post('/subscribe', anyone, async (req, res) => {
    const s = requireSession(res);
    const body = subscribeSchema.parse(req.body);
    await push.subscribe({ userId: s.user.id, sessionId: s.sessionId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: req.get('user-agent')?.slice(0, 200) });
    res.status(201).json({ ok: true });
  });

  router.post('/unsubscribe', anyone, async (req, res) => {
    const s = requireSession(res);
    await push.unsubscribe(s.user.id, unsubscribeSchema.parse(req.body).endpoint);
    res.json({ ok: true });
  });

  // "Send me a test alert": goes to this person's own devices only.
  router.post('/test', anyone, async (_req, res) => {
    const s = requireSession(res);
    res.json({ sentTo: await push.sendTest(s.user.id) });
  });

  return router;
}
