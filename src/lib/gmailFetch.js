// src/lib/gmailFetch.js
export async function fetchGmailMessageText({ accessToken, messageId }) {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`gmail get failed: ${res.status}`);
    const msg = await res.json();
  
    // Pull text from snippet + decoded body parts
    let text = msg.snippet || "";
    const parts = msg?.payload?.parts || [];
    for (const p of parts) {
      const mime = p?.mimeType || "";
      const data = p?.body?.data;
      if (!data) continue;
      if (mime.includes("text/plain") || mime.includes("text/html")) {
        const decoded = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        text += "\n" + decoded;
      }
    }
    return text;
  }
  