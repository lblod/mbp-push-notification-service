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
  const deleteFields = [];
  const insertFields = [];

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
