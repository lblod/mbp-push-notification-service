# mbp-push-notification-service

Stores **saved filters** for LokaalBeslist users (keyed to the MBP-authenticated account) and runs a **daily scan** that checks whether each saved filter has new matching agenda points. When it does, this service calls `mbp-notification-service` to deliver an inbox message via the Digitaal Vlaanderen Notificaties module.

Part of the [LBLOD](https://lblod.github.io) stack, built on the [mu-semtech](https://mu.semte.ch) microservice framework.

```
Frontend  ──POST /saved-filters──►  this service (auth via mu-session-id)
                                     INSERT ext:hasSavedFilter on the account

cron      ──POST /send-notifications──►  this service
                                          mu-search for new matches per filter
                                          ──POST /notifications/user──►  mbp-notification-service
                                                                          ──POST /api/v2/notificaties──► Notificaties module
                                          UPDATE ext:lastNotifiedAt
```

## Data model

Stored in `<http://mu.semte.ch/graphs/sessions>` alongside the account/session triples produced by `mbp-sso-service`.

```
<account-uri> ext:hasSavedFilter <filter-uri> .

<filter-uri>
  a ext:SavedFilter ;
  mu:uuid "{uuid}" ;
  dcterms:title "Mobiliteit Aalst" ;
  ext:filterData "{...AgendaItemsParams JSON...}" ;
  ext:notify true ;            # toggled from the UI; filters with notify=false are skipped in the scan
  dcterms:created "..." ;
  dcterms:modified "..." ;
  ext:lastNotifiedAt "..." .   # set by the daily scan
```

`ext:filterData` is the JSON object the LokaalBeslist frontend uses to drive the agenda-items search (`AgendaItemsParams` — `keyword`, `municipalityLabels`, `themeIds`, `governingBodyClassificationIds`, `plannedStartMin/Max`, …). The backend re-executes it via mu-search at scan time.

## API

### `POST /saved-filters`  *(authenticated)*

Auth via the `mu-session-id` header set by mu-identifier; the session is looked up in the sessions graph to resolve the account URI.

```json
{
  "data": {
    "attributes": {
      "name": "Mobiliteit Aalst",
      "filter": {
        "keyword": "mobiliteit",
        "municipalityLabels": ["Aalst"],
        "themeIds": ["..."],
        "governingBodyClassificationIds": []
      }
    }
  }
}
```

`201` → `{ data: { type: "saved-filters", id, attributes: { id, uri, name, filter, createdAt } } }`

### `GET /saved-filters`  *(authenticated)*

Returns all saved filters owned by the calling user.

### `PUT /saved-filters/:id`  *(authenticated)*

Updates `name`, `filter` and/or `notify` on one of the caller's saved filters.

```json
{ "data": { "attributes": { "name": "...", "filter": { ... }, "notify": false } } }
```

`204` on success.

### `DELETE /saved-filters/:id`  *(authenticated)*

Deletes one of the caller's saved filters. `204` on success.

### `POST /send-notifications`  *(internal — do **not** expose via the dispatcher)*

The daily-scan entry point. For every saved filter whose owning account has a stored `ext:rijksregisternummer`:

1. Pick a `since` watermark — `ext:lastNotifiedAt` if set, otherwise `now - 24h`.
2. Build a mu-search query from `ext:filterData` and ask `/agenda-items/search` for the count of items modified since the watermark.
3. If `count > 0`, POST to `mbp-notification-service`'s `POST /notifications/user` with the user's RRN, a Dutch title/body referencing the filter name and count, and a deep-link back to the filter view.
4. Advance `ext:lastNotifiedAt` to the start of the run so the next scan only sees newer changes.

Filters belonging to accounts without an RRN are skipped (the SSO service back-fills the RRN on next login if the ACM/IDM scope exposes it).

Response: `{ ok, scanned, notified, skipped, errors }`.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MU_SPARQL_ENDPOINT` | yes | — | SPARQL endpoint of the triplestore (set by the stack) |
| `SEARCH_BASE_URL` | no | `http://search` | mu-search service URL |
| `NOTIFICATION_SERVICE_URL` | no | `http://notification` | URL of `mbp-notification-service` |
| `LOKAALBESLIST_PUBLIC_URL` | no | `https://lokaalbeslist.be` | Used to build the deep-link in the notification |

## Wiring into the stack

Add to `app-burgernabije-besluitendatabank/docker-compose.yml`:

```yaml
push-notification:
  image: lblod/mbp-push-notification-service:latest    # or build: ../mbp-push-notification-service
  environment:
    NOTIFICATION_SERVICE_URL: "http://notification"
    LOKAALBESLIST_PUBLIC_URL: "https://lokaalbeslist.be"
```

Add to `mbp-dispatcher.ex` (only the CRUD routes — `/send-notifications` stays internal):

```elixir
post "/saved-filters", @json do
  Proxy.forward conn, [], "http://push-notification/saved-filters"
end
get "/saved-filters", @json do
  Proxy.forward conn, [], "http://push-notification/saved-filters"
end
delete "/saved-filters/:id", @json do
  Proxy.forward conn, ["/" <> id], "http://push-notification/saved-filters/"
end
```

Schedule the daily scan — simplest is a small cron sidecar that posts to the internal URL:

```yaml
push-notification-cron:
  image: alpine:3
  entrypoint: ["/bin/sh", "-c"]
  command:
    - |
      apk add --no-cache curl &&
      echo "0 7 * * * curl -fsS -X POST http://push-notification/send-notifications" | crontab - &&
      crond -f -L /dev/stdout
```

## Frontend integration

The LokaalBeslist frontend keeps a local cache of saved filters in `localStorage` and synchronises with this service when the user is authenticated:

- On `save` — POST `/saved-filters`; the returned `id` is stored as `remoteId` on the local Filter.
- On `edit` — PUT `/saved-filters/:remoteId` (falls back to POST for filters that pre-date the backend).
- On `delete` — DELETE `/saved-filters/:remoteId`.
- On notification-toggle — PUT `/saved-filters/:remoteId` with `{ notify }`.
- On session bootstrap — GET `/saved-filters` and merge into local state (filters that exist only locally are uploaded; filters that exist only on the backend are added to the local list).

Anonymous users keep working off localStorage only and won't get daily notifications (no backend record, no RRN to address).

## Assumptions worth verifying

- The mu-search index name for agenda items is `agenda-items` (matches `app-burgernabije-besluitendatabank/config/search/config.json`).
- Agenda items expose a `modified` date in the search index — used for the "new since last scan" filter. If the actual field is different (e.g. `created`, `dct_modified`), adjust `helpers/search.js`.
- `helpers/search.js` translates the most common `AgendaItemsParams` fields. New filter fields added on the frontend won't be honoured until the translator is extended; this is the same set of fields handled by `frontend/app/utils/search/agenda-items-query.ts`.
