import jwt from "jsonwebtoken";

/**
 * Verifies the Supabase JWT in the Authorization header.
 * Returns the userId (decoded.sub) on success, or sends a 401 and returns null.
 *
 * Usage in route handlers:
 *   const userId = requireUser(req, reply);
 *   if (!userId) return;
 */
export function requireUser(req, reply) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    const userId = decoded.sub;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return userId;
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
}
