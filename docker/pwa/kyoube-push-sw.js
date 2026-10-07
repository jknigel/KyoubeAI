// KyoubeAI's push handlers. docker/pwa appends `importScripts("/kyoube-push-sw.js")`
// to the core's own service worker (/sw.js), so this runs in the same worker
// as the core's caching and update logic and adds only these two listeners.
// The kyoube.notify plugin sends { title, body, url, tag } (docs/mobile.md).

function kyoubeSafePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== "object") data = {};
  // Always show something: Safari withdraws push permission from a site whose pushes show nothing.
  const title = typeof data.title === "string" && data.title ? data.title : "KyoubeAI";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag,
      renotify: Boolean(tag),
      icon: "/android-chrome-192x192.png",
      badge: "/android-chrome-192x192.png",
      data: { url: kyoubeSafePath(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(kyoubeSafePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if (typeof client.focus === "function") await client.focus();
        if (typeof client.navigate === "function") await client.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
