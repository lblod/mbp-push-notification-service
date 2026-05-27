const SEARCH_BASE_URL = process.env.SEARCH_BASE_URL || 'http://search';

// Translates a saved filter (AgendaItemsParams JSON, as built by the frontend) into the
// query-parameter shape accepted by mu-search. Mirrors `createAgendaItemsQuery` /
// `buildFilters` in frontend-lokaal-beslist-mijn-burgerprofiel; covers the bulk of
// commonly-used fields. Extend here when new filter fields are added on the frontend.
export function buildAgendaItemSearchParams(filter, sinceIso) {
  const params = new URLSearchParams();
  params.set('filter[:has:search_location_id]', 't');

  const ranges = [];
  if (sinceIso) ranges.push(`modified:[${sinceIso} TO *]`);
  if (filter?.plannedStartMin || filter?.plannedStartMax) {
    ranges.push(`session_planned_start:[${filter.plannedStartMin || '*'} TO ${filter.plannedStartMax || '*'}]`);
  }
  for (const r of ranges) params.append('filter[:query:session_planned_start]', r);

  if (Array.isArray(filter?.locationIds) && filter.locationIds.length) {
    params.set('filter[:terms:search_location_id]', filter.locationIds.join(','));
  }
  if (Array.isArray(filter?.themeIds) && filter.themeIds.length) {
    const q = filter.themeIds.map((id) => `"${id}"`).join(' OR ');
    params.set('filter[:query:themas.uuid]', q);
  }
  if (Array.isArray(filter?.governingBodyClassificationIds) && filter.governingBodyClassificationIds.length) {
    params.set('filter[:terms:search_governing_body_classification_id]', filter.governingBodyClassificationIds.join(','));
  }
  if (filter?.keyword) {
    params.set('filter[:query:search_content]', filter.keyword);
  }

  params.set('page[size]', '1');
  return params;
}

export async function countMatchingAgendaItems(filter, sinceIso) {
  const params = buildAgendaItemSearchParams(filter, sinceIso);
  const url = `${SEARCH_BASE_URL}/agenda-items/search?${params.toString()}`;

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`mu-search request failed: ${e.message}`);
  }
  if (!response.ok) {
    throw new Error(`mu-search returned ${response.status} for ${url}`);
  }
  const body = await response.json();
  return body?.count ?? body?.meta?.count ?? 0;
}
