import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime, sparqlEscapeInt } from 'mu';
import { querySudo, updateSudo } from '@lblod/mu-auth-sudo';

const SESSIONS_GRAPH = 'http://mu.semte.ch/graphs/sessions';
const FILTER_BASE_URI = 'http://data.lblod.info/id/saved-filters/';

export async function resolveAccountFromSession(sessionUri) {
  if (!sessionUri) return null;

  const result = await querySudo(`
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

    SELECT ?account ?rrn WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(sessionUri)} ext:sessionAccount ?account .
        OPTIONAL { ?account ext:rijksregisternummer ?rrn }
      }
    } LIMIT 1
  `);

  const binding = result.results.bindings[0];
  if (!binding) return null;
  return { accountUri: binding.account.value, rrn: binding.rrn?.value || null };
}

export async function createSavedFilter({ accountUri, name, filter, notify = true, count }) {
  const filterId = crypto.randomUUID();
  const filterUri = `${FILTER_BASE_URI}${filterId}`;
  const now = new Date();
  const seenCount = normalizeCount(count);

  await updateSudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    INSERT DATA {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ${sparqlEscapeUri(filterUri)} .

        ${sparqlEscapeUri(filterUri)}
          a ext:SavedFilter ;
          mu:uuid ${sparqlEscapeString(filterId)} ;
          dcterms:title ${sparqlEscapeString(name || 'Naamloze filter')} ;
          ext:filterData ${sparqlEscapeString(JSON.stringify(filter))} ;
          ext:notify ${notify ? 'true' : 'false'} ;${seenCount === null ? '' : `
          ext:lastSeenCount ${sparqlEscapeInt(seenCount)} ;`}
          dcterms:created ${sparqlEscapeDateTime(now)} ;
          dcterms:modified ${sparqlEscapeDateTime(now)} .
      }
    }
  `);

  return { id: filterId, uri: filterUri, name, filter, notify, lastSeenCount: seenCount, createdAt: now.toISOString() };
}

export async function updateSavedFilter({ accountUri, filterId, name, filter, notify, count }) {
  const now = new Date();
  const deleteFields = [];
  const insertFields = [];
  const optionalDeletes = [];

  if (typeof name === 'string') {
    deleteFields.push(`?filter dcterms:title ?oldTitle .`);
    insertFields.push(`?filter dcterms:title ${sparqlEscapeString(name)} .`);
  }
  if (filter !== undefined) {
    deleteFields.push(`?filter ext:filterData ?oldData .`);
    insertFields.push(`?filter ext:filterData ${sparqlEscapeString(JSON.stringify(filter))} .`);
  }
  if (typeof notify === 'boolean') {
    deleteFields.push(`?filter ext:notify ?oldNotify .`);
    insertFields.push(`?filter ext:notify ${notify ? 'true' : 'false'} .`);
  }
  const seenCount = normalizeCount(count);
  if (seenCount !== null) {
    // Editing the filter re-baselines the high-water mark to the count the user sees now.
    deleteFields.push(`?filter ext:lastSeenCount ?oldSeenCount .`);
    insertFields.push(`?filter ext:lastSeenCount ${sparqlEscapeInt(seenCount)} .`);
    optionalDeletes.push(`OPTIONAL { ?filter ext:lastSeenCount ?oldSeenCount }`);
  }
  if (!insertFields.length) return;

  deleteFields.push(`?filter dcterms:modified ?oldModified .`);
  insertFields.push(`?filter dcterms:modified ${sparqlEscapeDateTime(now)} .`);

  await updateSudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    DELETE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${deleteFields.join('\n        ')}
      }
    } INSERT {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${insertFields.join('\n        ')}
      }
    } WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ?filter .
        ?filter a ext:SavedFilter ;
                mu:uuid ${sparqlEscapeString(filterId)} .
        OPTIONAL { ?filter dcterms:title ?oldTitle }
        OPTIONAL { ?filter ext:filterData ?oldData }
        OPTIONAL { ?filter ext:notify ?oldNotify }
        OPTIONAL { ?filter dcterms:modified ?oldModified }
        ${optionalDeletes.join('\n        ')}
      }
    }
  `);
}

export async function listSavedFiltersForAccount(accountUri) {
  const result = await querySudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    SELECT ?filter ?id ?title ?data ?notify ?created ?lastNotifiedAt ?lastSeenCount WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ?filter .
        ?filter a ext:SavedFilter ;
                mu:uuid ?id ;
                dcterms:title ?title ;
                ext:filterData ?data ;
                dcterms:created ?created .
        OPTIONAL { ?filter ext:notify ?notify }
        OPTIONAL { ?filter ext:lastNotifiedAt ?lastNotifiedAt }
        OPTIONAL { ?filter ext:lastSeenCount ?lastSeenCount }
      }
    } ORDER BY ?created
  `);

  return result.results.bindings.map((b) => ({
    id: b.id.value,
    uri: b.filter.value,
    name: b.title.value,
    filter: safeJson(b.data.value),
    notify: parseSparqlBoolean(b.notify),
    createdAt: b.created.value,
    lastNotifiedAt: b.lastNotifiedAt?.value || null,
    lastSeenCount: parseSparqlInt(b.lastSeenCount),
  }));
}

export async function deleteSavedFilter({ accountUri, filterId }) {
  await updateSudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>

    DELETE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ?filter .
        ?filter ?p ?o .
      }
    } WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ?filter .
        ?filter a ext:SavedFilter ;
                mu:uuid ${sparqlEscapeString(filterId)} ;
                ?p ?o .
      }
    }
  `);
}

export async function listAllNotifiableFilters() {
  const result = await querySudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    SELECT ?account ?rrn ?filter ?id ?title ?data ?lastNotifiedAt ?lastSeenCount ?created WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ?account ext:hasSavedFilter ?filter ;
                 ext:rijksregisternummer ?rrn .
        ?filter a ext:SavedFilter ;
                mu:uuid ?id ;
                dcterms:title ?title ;
                ext:filterData ?data ;
                dcterms:created ?created .
        OPTIONAL { ?filter ext:lastNotifiedAt ?lastNotifiedAt }
        OPTIONAL { ?filter ext:lastSeenCount ?lastSeenCount }
        FILTER NOT EXISTS { ?filter ext:notify false }
      }
    }
  `);

  return result.results.bindings.map((b) => ({
    accountUri: b.account.value,
    rrn: b.rrn.value,
    uri: b.filter.value,
    id: b.id.value,
    name: b.title.value,
    filter: safeJson(b.data.value),
    createdAt: b.created.value,
    lastNotifiedAt: b.lastNotifiedAt?.value || null,
    lastSeenCount: parseSparqlInt(b.lastSeenCount),
  }));
}

export async function markFilterNotified(filterUri, at) {
  await updateSudo(`
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

    DELETE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(filterUri)} ext:lastNotifiedAt ?old .
      }
    } INSERT {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(filterUri)} ext:lastNotifiedAt ${sparqlEscapeDateTime(at)} .
      }
    } WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        OPTIONAL { ${sparqlEscapeUri(filterUri)} ext:lastNotifiedAt ?old }
      }
    }
  `);
}

// Persist the latest observed match count as the new high-water mark for the filter.
export async function updateFilterSeenCount(filterUri, count) {
  const seenCount = normalizeCount(count);
  if (seenCount === null) return;

  await updateSudo(`
    PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

    DELETE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(filterUri)} ext:lastSeenCount ?old .
      }
    } INSERT {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(filterUri)} ext:lastSeenCount ${sparqlEscapeInt(seenCount)} .
      }
    } WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        OPTIONAL { ${sparqlEscapeUri(filterUri)} ext:lastSeenCount ?old }
      }
    }
  `);
}

// Resolve municipality/province labels (as stored in ext:filterData) to the
// werkingsgebied location uuids used by the agenda-items search index
// (search_location_id). Mirrors the frontend's municipality/province list lookup,
// which matches prov:Location by rdfs:label (case-insensitive).
export async function resolveLocationIdsForLabels(labels) {
  const wanted = (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l.trim() : ''))
    .filter(Boolean)
    .map((l) => l.toLowerCase());
  if (!wanted.length) return [];

  const values = wanted.map((l) => sparqlEscapeString(l)).join(' ');

  const result = await querySudo(`
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>

    SELECT DISTINCT ?uuid WHERE {
      VALUES ?wanted { ${values} }
      GRAPH ?g {
        ?location a prov:Location ;
                  rdfs:label ?label ;
                  mu:uuid ?uuid .
      }
      FILTER(LCASE(STR(?label)) = ?wanted)
    }
  `);

  return result.results.bindings.map((b) => b.uuid.value);
}

// Coerce an incoming count to a non-negative integer, or null when absent/invalid.
function normalizeCount(count) {
  if (count === undefined || count === null || count === '') return null;
  const n = Number(count);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function parseSparqlInt(binding) {
  if (!binding) return null;
  const n = Number(binding.value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

// Virtuoso serializes xsd:boolean as "0"/"1", other stores as "false"/"true".
// Treat a missing binding as the default (notify enabled).
function parseSparqlBoolean(binding, defaultValue = true) {
  if (!binding) return defaultValue;
  return binding.value !== 'false' && binding.value !== '0';
}
