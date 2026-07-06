/**
 * ntfy.sh notification sender — equivalent to Go's sendNtfyNotification()
 */

const NTFY_TOPIC = process.env.NTFY_TOPIC || "wa-tracker-anonym090";
const NTFY_URL = process.env.NTFY_URL || "https://ntfy.sh";
const NTFY_ICON =
  process.env.NTFY_ICON ||
  "https://cdn-icons-png.flaticon.com/512/124/124034.png";

async function sendNtfyNotification(message) {
  try {
    const url = `${NTFY_URL}/${NTFY_TOPIC}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: "WhatsApp Tracker",
        Tags: "eyes",
        Icon: NTFY_ICON,
      },
      body: message,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`ntfy error: ${response.status}`);
    }
  } catch (err) {
    console.error("ntfy notification failed:", err.message);
  }
}

module.exports = { sendNtfyNotification };
