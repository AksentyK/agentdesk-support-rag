import {
  createHash,
  timingSafeEqual,
  createHmac,
  randomUUID,
} from "node:crypto";
import { db } from "./db";
import { AppError } from "./errors";
const digest = (s: string) => createHash("sha256").update(s).digest();
export function passwordMatches(candidate: string, actual: string) {
  return timingSafeEqual(digest(candidate), digest(actual));
}
export function signSession(id: string, expires: number, password: string) {
  const payload = id + "." + expires;
  return (
    payload + "." + createHmac("sha256", password).update(payload).digest("hex")
  );
}
export function sessionOwner(cookie: string | undefined, password: string) {
  if (!cookie) return null;
  const [id, expiry, sig] = cookie.split(".");
  if (
    !id ||
    !sig ||
    !Number.isFinite(Number(expiry)) ||
    Number(expiry) < Date.now()
  )
    return null;
  return passwordMatches(cookie, signSession(id, Number(expiry), password))
    ? id
    : null;
}
export function newSession(password: string) {
  return signSession(randomUUID(), Date.now() + 12 * 3600 * 1000, password);
}
const limits = new Map<string, { count: number; expires: number }>();
export async function rateLimit(
  key: string,
  max: number,
  seconds = 60,
  persistent = true,
) {
  if (persistent && process.env.DATABASE_URL) {
    const id = createHash("sha256").update(key).digest("hex");
    const rows = await db().$queryRaw<
      { count: number }[]
    >`INSERT INTO "RateLimit" (id,count,"expiresAt") VALUES (${id},1,NOW()+${seconds}*interval '1 second') ON CONFLICT (id) DO UPDATE SET count=CASE WHEN "RateLimit"."expiresAt"<NOW() THEN 1 ELSE "RateLimit".count+1 END,"expiresAt"=CASE WHEN "RateLimit"."expiresAt"<NOW() THEN NOW()+${seconds}*interval '1 second' ELSE "RateLimit"."expiresAt" END RETURNING count`;
    if (rows[0].count > max)
      throw new AppError(429, "Слишком много запросов. Повторите позже.");
    return;
  }
  const now = Date.now();
  for (const [k, v] of limits) if (v.expires < now) limits.delete(k);
  const current = limits.get(key);
  if (!current || current.expires < now)
    limits.set(key, { count: 1, expires: now + seconds * 1000 });
  else if (++current.count > max)
    throw new AppError(429, "Слишком много запросов. Повторите позже.");
}
