/**
 * 모아니 서비스 워커 — 방송 알림(웹 푸시) 하나만 맡는다(2026-10-29).
 *
 * 캐시는 하지 않는다. 오프라인 모드를 만들려는 것이 아니라, 아이폰·안드로이드가
 * 앱을 닫아 둔 동안에도 알림을 받으려면 서비스 워커가 있어야 해서 둔다.
 * 화면 코드가 이 파일을 등록한다(src/services/pushClient.ts).
 *
 * 알림 내용은 보내는 쪽(push-worker)이 암호화해 실어 보낸 JSON 이다:
 *   { title, body, url, tag }
 * tag 가 같으면 같은 회차 알림이 두 번 쌓이지 않고 하나로 바뀐다.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // 알림을 띄우지 않는 푸시는 브라우저가 막는다(userVisibleOnly) — 내용이 비어도 늘 하나는 띄운다.
  event.waitUntil(self.registration.showNotification(data.title || '모아니', {
    body: data.body || '담은 애니의 방송이 곧 시작돼요',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    lang: 'ko',
    data: { url: data.url || '/' },
  }));
});

// 알림을 누르면 그 작품 상세로. 이미 열린 모아니 창이 있으면 그 창을 쓴다.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
