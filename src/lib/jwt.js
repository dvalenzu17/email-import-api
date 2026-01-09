import { jwtVerify } from "jose";

export async function verifySupabaseJwt(token, secret) {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("JWT missing sub");
  }
  return { sub: payload.sub };
}
