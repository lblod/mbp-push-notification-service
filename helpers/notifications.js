const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://mbp-notification-delivery-service';
const LOKAALBESLIST_PUBLIC_URL = process.env.LOKAALBESLIST_PUBLIC_URL || 'https://mbp.lokaalbeslist.lblod.info';

export async function notifySavedFilterUpdate({ rrn, filterId, filterName, newMatchCount, filter }) {
  const title = `Nieuwe agendapunten voor "${filterName}"`;
  const body = newMatchCount === 1
    ? `Uw opgeslagen filter "${filterName}" heeft 1 nieuw agendapunt.`
    : `Uw opgeslagen filter "${filterName}" heeft ${newMatchCount} nieuwe agendapunten.`;

  return postUserNotification({
    rrn,
    title,
    body,
    linkUrl: buildFilterDeepLink(filter),
    linkLabel: 'Bekijk filter',
    transactieId: `lokaalbeslist:filter:${filterId}`,
  });
}

// Build a deep-link into the LokaalBeslist (MBP-embedded) frontend that re-applies the saved
// filter. The agenda-items route at `/` reads these query params on load and applies them —
// the param names and array separators mirror the frontend's QueryParameterKeys / serializeArray.
function buildFilterDeepLink(filter) {
  const f = filter || {};
  const params = new URLSearchParams();

  const addArray = (key, arr, separator = '+') => {
    if (Array.isArray(arr) && arr.length) params.set(key, arr.join(separator));
  };
  const addScalar = (key, value) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  };

  addArray('gemeentes', f.municipalityLabels);
  addArray('provincies', f.provinceLabels);
  addArray('bestuursorganen', f.governingBodyClassificationIds, ',');
  addScalar('begin', f.plannedStartMin);
  addScalar('eind', f.plannedStartMax);
  addScalar('trefwoord', f.keyword);
  addScalar('zoekOpTitel', f.keywordSearchOnlyInTitle);
  if (f.dateSort && f.dateSort !== 'desc') addScalar('datumsortering', f.dateSort);
  if (f.status && f.status !== 'Alles') addScalar('status', f.status);
  addArray('thema', f.themeIds);
  addScalar('straat', f.street);
  addScalar('afstand', f.distance);

  const qs = params.toString();
  return qs ? `${LOKAALBESLIST_PUBLIC_URL}/?${qs}` : LOKAALBESLIST_PUBLIC_URL;
}

async function postUserNotification(payload) {
  let response;
  try {
    response = await fetch(`${NOTIFICATION_SERVICE_URL}/notifications/user`, {
      method: 'POST',
      // The delivery service runs on the mu-javascript-template, whose body parser
      // only accepts the JSON:API content type — bare application/json is dropped.
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/json' },
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
