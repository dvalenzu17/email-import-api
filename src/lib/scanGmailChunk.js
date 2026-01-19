import { getFreshGoogleAccessToken } from "./googleAuth.js";

// This is the ONLY contract you need: process at most N messages, return nextCursor/done.
export async function scanGmailChunk({ supabase, session }) {
  const userId = session.user_id;
  const accessToken = await getFreshGoogleAccessToken({ supabase, userId });

  const options = session.options ?? {};
  const maxPerChunk = Number(options.maxPerChunk ?? 250);

  // TODO: replace with your existing Gmail list + fetch + parse logic
  // Use `session.cursor` as the pageToken / cursor.
  // Return:
  //  - nextCursor: string|null
  //  - done: boolean
  //  - scannedDelta: number
  //  - foundDelta: number
  //  - lastStats: json

  // Placeholder contract:
  return {
    nextCursor: null,
    done: true,
    scannedDelta: 0,
    foundDelta: 0,
    lastStats: { maxPerChunk, hint: "wire this to your Gmail scan implementation" },
  };
}
