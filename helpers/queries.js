import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeDateTime } from 'mu';
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

export async function createSavedFilter({ accountUri, name, filter, notify = true }) {
  const filterId = crypto.randomUUID();
  const filterUri = `${FILTER_BASE_URI}${filterId}`;
  const now = new Date();

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
          ext:notify ${notify ? 'true' : 'false'} ;
          dcterms:created ${sparqlEscapeDateTime(now)} ;
          dcterms:modified ${sparqlEscapeDateTime(now)} .
      }
    }
  `);

  return { id: filterId, uri: filterUri, name, filter, notify, createdAt: now.toISOString() };
}

export async function updateSavedFilter({ accountUri, filterId, name, filter, notify }) {
  const now = new Date();
  const fields = [];
  if (typeof name === 'string') fields.push(`?filter dcterms:title ${sparqlEscapeString(name)} .`);
  if (filter !== undefined) fields.push(`?filter ext:filterData ${sparqlEscapeString(JSON.stringify(filter))} .`);
  if (typeof notify === 'boolean') fields.push(`?filter ext:notify ${notify ? 'true' : 'false'} .`);
  if (!fields.length) return;

  await updateSudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    DELETE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ?filter dcterms:title ?oldTitle .
        ?filter ext:filterData ?oldData .
        ?filter ext:notify ?oldNotify .
        ?filter dcterms:modified ?oldModified .
      }
    } INSERT {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${fields.join('\n        ')}
        ?filter dcterms:modified ${sparqlEscapeDateTime(now)} .
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
      }
    }
  `);
}

export async function listSavedFiltersForAccount(accountUri) {
  const result = await querySudo(`
    PREFIX ext:     <http://mu.semte.ch/vocabularies/ext/>
    PREFIX mu:      <http://mu.semte.ch/vocabularies/core/>
    PREFIX dcterms: <http://purl.org/dc/terms/>

    SELECT ?filter ?id ?title ?data ?notify ?created ?lastNotifiedAt WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ${sparqlEscapeUri(accountUri)} ext:hasSavedFilter ?filter .
        ?filter a ext:SavedFilter ;
                mu:uuid ?id ;
                dcterms:title ?title ;
                ext:filterData ?data ;
                dcterms:created ?created .
        OPTIONAL { ?filter ext:notify ?notify }
        OPTIONAL { ?filter ext:lastNotifiedAt ?lastNotifiedAt }
      }
    } ORDER BY ?created
  `);

  return result.results.bindings.map((b) => ({
    id: b.id.value,
    uri: b.filter.value,
    name: b.title.value,
    filter: safeJson(b.data.value),
    notify: b.notify?.value !== 'false',
    createdAt: b.created.value,
    lastNotifiedAt: b.lastNotifiedAt?.value || null,
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

    SELECT ?account ?rrn ?filter ?id ?title ?data ?lastNotifiedAt ?created WHERE {
      GRAPH ${sparqlEscapeUri(SESSIONS_GRAPH)} {
        ?account ext:hasSavedFilter ?filter ;
                 ext:rijksregisternummer ?rrn .
        ?filter a ext:SavedFilter ;
                mu:uuid ?id ;
                dcterms:title ?title ;
                ext:filterData ?data ;
                dcterms:created ?created .
        OPTIONAL { ?filter ext:lastNotifiedAt ?lastNotifiedAt }
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

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
