import { resolveLocationIdsForLabels } from './queries';

const SEARCH_BASE_URL = process.env.SEARCH_BASE_URL || 'http://search';

// True when the filter relies on a street-address geo (distance) search.
export function usesGeoSearch(filter) {
  return !!(filter?.street && String(filter.street).trim());
}

// True when the saved filter carries the Lambert-72 coordinates the frontend resolved for
// `street`. Without them the scan cannot reproduce the geo search (see app.js: such filters
// are skipped). The frontend persists these via filter-service.withResolvedCoordinates.
export function hasGeoCoordinates(filter) {
  return (
    Number.isFinite(Number(filter?.addressXLambert72)) &&
    Number.isFinite(Number(filter?.addressYLambert72))
  );
}

// Translates a saved filter (AgendaItemsParams JSON, as built by the frontend) into the
// query-parameter shape accepted by mu-search. Mirrors `createAgendaItemsQuery` /
// `buildFilters` in frontend-lokaal-beslist-mijn-burgerprofiel. Async because municipality
// and province labels are resolved to location uuids via SPARQL.
//
// NOTE: the agenda-items index has no per-item modified/created date, so freshness is
// tracked via a stored result-count high-water mark (ext:lastSeenCount), not a time window.
export async function buildAgendaItemSearchParams(filter) {
  const params = new URLSearchParams();
  params.set('filter[:has:search_location_id]', 't');

  // Planned-start range — the frontend applies it only when a lower bound is set.
  if (filter?.plannedStartMin) {
    params.append(
      'filter[:query:session_planned_start]',
      `session_planned_start:[${filter.plannedStartMin} TO ${filter.plannedStartMax || '*'}]`,
    );
  }

  await applyLocationOrGeo(params, filter);

  if (Array.isArray(filter?.themeIds) && filter.themeIds.length) {
    params.set('filter[:terms:search_theme_id]', filter.themeIds.join(','));
  }
  if (Array.isArray(filter?.governingBodyClassificationIds) && filter.governingBodyClassificationIds.length) {
    params.set('filter[:terms:search_governing_body_classification_id]', filter.governingBodyClassificationIds.join(','));
  }

  applyKeyword(params, filter);
  applyStatus(params, filter);

  params.set('page[size]', '1');
  return params;
}

// Street/distance → geo search around the stored coordinates (the frontend skips location
// terms when an address is active); otherwise municipality/province labels → location uuids.
async function applyLocationOrGeo(params, filter) {
  if (usesGeoSearch(filter)) {
    if (hasGeoCoordinates(filter)) {
      const x = Number(filter.addressXLambert72);
      const y = Number(filter.addressYLambert72);
      const km = Number(filter.distance) > 0 ? Number(filter.distance) : 50;
      params.set('filter[:geo:address_geometry_coord]', `${x}, ${y},${km}km`);
    }
    return;
  }

  const labels = [
    ...(Array.isArray(filter?.municipalityLabels) ? filter.municipalityLabels : []),
    ...(Array.isArray(filter?.provinceLabels) ? filter.provinceLabels : []),
  ];
  const locationIds = await resolveLocationIdsForLabels(labels);
  if (locationIds.length) {
    params.set('filter[:terms:search_location_id]', locationIds.join(','));
  }
}

// Mirrors the keyword branch of the frontend's buildFilters for the common cases.
// The frontend additionally supports AND/OR/NOT operators (via keywordSearch); for a plain
// keyword it falls back to a fuzzy match, which is what we reproduce here.
function applyKeyword(params, filter) {
  const keyword = filter?.keyword;
  if (!keyword) return;

  if (keyword === '-title*' || keyword === '-description*') {
    if (keyword.includes('title')) params.set('filter[:has-no:title]', 't');
    else params.set('filter[:has-no:description]', 't');
    return;
  }

  const titleOnly = filter?.keywordSearchOnlyInTitle === 'true' || filter?.keywordSearchOnlyInTitle === true;
  if (titleOnly) {
    params.set('filter[:fuzzy:title]', keyword);
  } else {
    params.set('filter[:fuzzy:search_content]', keyword);
  }
}

function applyStatus(params, filter) {
  if (filter?.status === 'Behandeld') {
    params.set('filter[:has:session_started_at]', 't');
  } else if (filter?.status === 'Niet behandeld') {
    params.set('filter[:has-no:session_started_at]', 't');
  }
}

export async function countMatchingAgendaItems(filter) {
  const body = await searchAgendaItems(filter);
  return body?.count ?? body?.meta?.count ?? 0;
}

// TEST helper: returns the uuid (mu-search id) of one agenda item currently matching the
// filter, so it can be cloned to grow the filter's count. Null when the filter has no matches.
export async function findOneMatchingAgendaItemId(filter) {
  const body = await searchAgendaItems(filter);
  return body?.data?.[0]?.id ?? null;
}

async function searchAgendaItems(filter) {
  const params = await buildAgendaItemSearchParams(filter);
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
  return response.json();
}
