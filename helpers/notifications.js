const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://notification';
const LOKAALBESLIST_PUBLIC_URL = process.env.LOKAALBESLIST_PUBLIC_URL || 'https://lokaalbeslist.be';

export async function notifySavedFilterUpdate({ rrn, filterId, filterName, newMatchCount }) {
  const title = `Nieuwe agendapunten voor "${filterName}"`;
  const body = newMatchCount === 1
    ? `Uw opgeslagen filter "${filterName}" heeft 1 nieuw agendapunt.`
    : `Uw opgeslagen filter "${filterName}" heeft ${newMatchCount} nieuwe agendapunten.`;

  return postUserNotification({
    rrn,
    title,
    body,
    linkUrl: `${LOKAALBESLIST_PUBLIC_URL}/filters/${encodeURIComponent(filterId)}`,
    linkLabel: 'Bekijk filter',
    transactieId: `lokaalbeslist:filter:${filterId}`,
  });
}

// Fire a simple, self-contained notification to a user — used by the manual
// test endpoint to verify the end-to-end delivery path without a saved filter.
export async function notifyTestMessage({ rrn }) {
  return postUserNotification({
    rrn,
    title: 'Testnotificatie LokaalBeslist',
    body: 'Dit is een testnotificatie. Als u dit bericht ziet, werkt de notificatieketen.',
    linkUrl: LOKAALBESLIST_PUBLIC_URL,
    linkLabel: 'Open LokaalBeslist',
    transactieId: `lokaalbeslist:test:${Date.now()}`,
  });
}

async function postUserNotification(payload) {
  let response;
  try {
    response = await fetch(`${NOTIFICATION_SERVICE_URL}/notifications/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`notification-service request failed: ${e.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`notification-service returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? safeJson(text) : null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
