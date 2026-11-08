/*
 * Two Hearts Cafe POS - service worker.
 * Its one job: show an order alert when the phone is locked or the app is in the background.
 * (While the app is open it plays its own bell / marimba sound, see src/lib/orderAlerts.ts.)
 * Deliberately no caching, so a new version of the app is always picked up straight away.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Different buzz patterns on Android, like the in-app sounds.
const VIBRATE = {
  NEW_ORDER: [320, 110, 320, 110, 520],
  ITEMS_ADDED: [320, 110, 320, 110, 520],
  CHANGED: [320, 110, 320],
  CANCELLED: [700, 150, 300],
  READY: [90, 70, 90, 70, 160],
};
// The kitchen's alerts stay on screen until someone taps them (where the phone allows it).
const STAY = new Set(['NEW_ORDER', 'ITEMS_ADDED', 'CHANGED', 'CANCELLED']);

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Order alert', body: event.data ? event.data.text() : '' };
  }
  const kind = data.kind || 'ORDER';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const appIsOnScreen = windows.some((w) => w.visibilityState === 'visible');
      const options = {
        body: data.body || '',
        tag: data.tag || 'order',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        // While the app is on screen it already plays its own sound and shows its own alert, so this one is
        // quiet and goes away by itself. (A quiet notification may not also vibrate or re-alert: browsers refuse that.)
        silent: appIsOnScreen,
        requireInteraction: !appIsOnScreen && STAY.has(kind),
        data: { url: data.url || '/', kind },
      };
      if (!appIsOnScreen) {
        options.renotify = true; // a newer alert for the same order still makes a sound
        options.vibrate = VIBRATE[kind] || [200, 100, 200];
      }
      await self.registration.showNotification(data.title || 'Two Hearts Cafe', options);
      if (appIsOnScreen) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const shown = await self.registration.getNotifications({ tag: data.tag || 'order' });
        shown.forEach((n) => n.close());
      }
    })(),
  );
});

// Tapping an alert brings the app to the front (or opens it).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.length > 0) return windows[0].focus();
      return self.clients.openWindow(url);
    })(),
  );
});
