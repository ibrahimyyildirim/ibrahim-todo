// İbrahim ToDo push service (Cloudflare Worker, scheduled only: it has no public URL).
// Every minute it reads the devices' push subscriptions (push.json) and the notes (todo.json) from the
// private GitHub repo and sends a Web Push (RFC 8291 encryption + RFC 8292 VAPID) to every subscribed
// device for each alarm that falls in that minute, so alarms arrive while the app is closed.
// A device asks for a test notification by putting a minute timestamp in its push.json entry ("test").
// Secrets (set in Cloudflare, never in this file): GITHUB_TOKEN (read-only, data repo), VAPID_PRIVATE_JWK.

const enc = new TextEncoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(b) {
  const bytes = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// RFC 8291 message encryption (aes128gcm, single record). opts.asKeyPair / opts.salt are only for tests.
export async function encryptPayload(plaintext, uaPublicB64u, authB64u, opts = {}) {
  const uaPublic = b64uToBytes(uaPublicB64u), auth = b64uToBytes(authB64u);
  const asKeys = opts.asKeyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(auth, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(data, new Uint8Array([2]))));
  // header: salt(16) | record size 4096 (uint32 BE) | key id length | key id (= our public key)
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic, sealed);
}

// RFC 8292 VAPID authorization header (ES256 JWT, valid 12 h)
export async function vapidAuth(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims));
  const publicKey = bytesToB64u(concat(new Uint8Array([4]), b64uToBytes(jwk.x), b64uToBytes(jwk.y)));
  return `vapid t=${header}.${claims}.${bytesToB64u(sig)}, k=${publicKey}`;
}

export async function sendPush(sub, payload, env, fetchImpl = fetch) {
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const r = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      "TTL": "3600", "Urgency": "high", "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream", "Authorization": await vapidAuth(sub.endpoint, env)
    },
    body
  });
  return r.status;
}

// one retry on a network error or a GitHub 5xx, so a single hiccup doesn't drop that minute's alarms
async function readRepoJson(env, file, fetchImpl = fetch) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetchImpl(`https://api.github.com/repos/${env.REPO}/contents/${file}?ref=main&_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.raw+json", "User-Agent": "ibrahim-todo-push" }
      });
    } catch (e) {
      if (attempt < 1) { await sleep(1500); continue; }
      throw e;
    }
    if (r.status === 404) return null;
    if (r.ok) return JSON.parse(await r.text());
    if (r.status >= 500 && attempt < 1) { await sleep(1500); continue; }
    throw new Error(`GitHub ${file}: ${r.status}`);
  }
}

// alarms in (from, to], not done
export function dueAlarms(doc, from, to) {
  return Object.entries((doc && doc.tasks) || {})
    .filter(([, t]) => t && t.alarm && t.alarm > from && t.alarm <= to && !t.done)
    .map(([id, t]) => ({ id, text: t.text || "", blurred: !!t.blurred }));
}
// iOS already prints "from İbrahim ToDo" under the title, so the title is the note itself (the name shows once).
// Hidden (blurred) notes never show their text on the lock screen.
export function notificationFor(alarm, appUrl) {
  const text = alarm.text.length > 300 ? alarm.text.slice(0, 300) + "…" : alarm.text;
  return JSON.stringify({ title: alarm.blurred ? "Gizli not" : (text || "Hatırlatma"), body: "",
    tag: "alarm-" + alarm.id, url: appUrl });
}
export function testNotification(appUrl) {
  return JSON.stringify({ title: "Test bildirimi",
    body: "Bildirimler çalışıyor, uygulama kapalıyken de alarmların gelecek.", tag: "test", url: appUrl });
}

export async function runAlarms(env, at, fetchImpl = fetch) {
  const to = Math.floor(at / 60000) * 60000, from = to - 60000;   // the cron minute: (from, to]
  const push = await readRepoJson(env, env.PUSH_FILE, fetchImpl);
  const subs = (push && Array.isArray(push.subs) ? push.subs : []).filter(s => s && s.endpoint && s.keys);
  if (!subs.length) return { due: [], results: [] };              // nobody subscribed: don't read the notes
  const jobs = [];
  for (const s of subs) if (s.test > from && s.test <= to) jobs.push({ id: "test", sub: s, payload: testNotification(env.APP_URL) });
  const due = dueAlarms(await readRepoJson(env, env.TODO_FILE, fetchImpl), from, to);
  for (const a of due) for (const s of subs) jobs.push({ id: a.id, sub: s, payload: notificationFor(a, env.APP_URL) });
  const results = await Promise.all(jobs.map(async j => {
    try { return { id: j.id, device: j.sub.device, status: await sendPush(j.sub, j.payload, env, fetchImpl) }; }
    catch (e) { return { id: j.id, device: j.sub.device, error: String(e) }; }
  }));
  // ids, devices and status codes only: note text never goes to the logs
  if (jobs.length) console.log(JSON.stringify({ minute: new Date(to).toISOString(), sent: results }));
  return { due, results };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlarms(env, event.scheduledTime).catch(e => console.error("alarm run failed: " + e)));
  }
};
