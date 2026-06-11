# mbp-push-notification-service

Stores **saved filters** for LokaalBeslist users (keyed to the MBP-authenticated account) and runs a **daily scan** that checks whether each saved filter has new matching agenda points. When it does, this service calls `mbp-notification-delivery-service` to deliver an inbox message via the Digitaal Vlaanderen Notificaties module.

Part of the [LBLOD](https://lblod.github.io) stack, built on the [mu-semtech](https://mu.semte.ch) microservice framework.

```
Frontend  ──POST /saved-filters──►  this service (auth via mu-session-id)
                                     INSERT ext:hasSavedFilter on the account

cron      ──POST /send-notifications──►  this service
                                          mu-search current match count per filter
                                          compare to stored ext:lastSeenCount (high-water mark)
                                          ──POST /notifications/user──►  mbp-notification-delivery-service
                                                                          ──POST /api/v2/notificaties──► Notificaties module
                                          UPDATE ext:lastSeenCount (and ext:lastNotifiedAt)
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
  ext:lastSeenCount 42 ;       # match-count high-water mark; the scan notifies on a positive delta
  dcterms:created "..." ;
  dcterms:modified "..." ;
  ext:lastNotifiedAt "..." .   # timestamp of the last notification (audit)
```

`ext:filterData` is the JSON object the LokaalBeslist frontend uses to drive the agenda-items search (`AgendaItemsParams` — `keyword`, `municipalityLabels`, `themeIds`, `governingBodyClassificationIds`, `plannedStartMin/Max`, …). The backend re-executes it via mu-search at scan time.

`ext:lastSeenCount` is the number of matching agenda items at the moment the user last saved/edited the filter (sent by the frontend as `count`). The daily scan recomputes the count and notifies the owner when it has grown, then advances the high-water mark. There is no per-item modified date in the agenda-items index, so this count delta — not a time window — is how "new items" is detected.

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
      },
      "count": 42
    }
  }
}
```

`count` (optional) is the number of results the user currently sees for this filter; it's stored as `ext:lastSeenCount` and becomes the baseline for the daily scan. `PUT /saved-filters/:id` accepts `count` too, to re-baseline when the filter is edited.

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

### `POST /test-notification`  *(authenticated)*

Manual end-to-end test. Resolves the calling user's RRN from the session and fires a single fixed "Testnotificatie" through `mbp-notification-delivery-service`. No body required.

- `202` → `{ ok: true }` when the notification was accepted upstream.
- `409` → `{ error: "no_rrn" }` when the account has no stored `ext:rijksregisternummer` (log in via ACM/IDM with the `rrn`-releasing scope first).
- `502` → `{ error: "notification_failed" }` when the notification service / Notificaties module rejected the request.

The MBP frontend wires this to a temporary "Stuur testnotificatie" button (`TestNotificationButton`), shown only to authenticated users.

### `POST /send-notifications`  *(internal — do **not** expose via the dispatcher)*

The daily-scan entry point. For every notifiable saved filter (owner has a stored `ext:rijksregisternummer`, `ext:notify` ≠ false):

1. Build a mu-search query from `ext:filterData` and ask `/agenda-items/search` for the **current total match count**.
2. Compare to the stored `ext:lastSeenCount`:
   - no baseline yet → record the current count, don't notify (`baselined`);
   - count grew → POST to `mbp-notification-delivery-service`'s `POST /notifications/user` with the user's RRN and the **delta** (e.g. "5 new agenda items"), plus a deep-link to the filter;
   - otherwise → skip.
3. Advance `ext:lastSeenCount` to the current count so the next run compares against it.

Filters belonging to accounts without an RRN are skipped (the SSO service back-fills the RRN on next login if the ACM/IDM scope exposes it).

Response: `{ ok, scanned, notified, skipped, baselined, unsupported, errors }` (`unsupported` = street/distance geo filters the scan can't reproduce).

Triggered on a schedule by the `mbp-push-notifications-cron` sidecar (see docker-compose) — this endpoint is internal and is not exposed via the dispatcher.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `MU_SPARQL_ENDPOINT` | yes | — | SPARQL endpoint of the triplestore (set by the stack) |
| `SEARCH_BASE_URL` | no | `http://search` | mu-search service URL |
| `NOTIFICATION_SERVICE_URL` | no | `http://notification` | URL of `mbp-notification-delivery-service` |
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
post "/test-notification", @json do
  Proxy.forward conn, [], "http://push-notification/test-notification"
end
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
- `helpers/search.js` mirrors `frontend-lokaal-beslist-mijn-burgerprofiel`'s `buildFilters` and applies: `keyword` (incl. title-only and the `-title*`/`-description*` negations, via fuzzy), `themeIds` (`:terms:search_theme_id`), `governingBodyClassificationIds`, `plannedStartMin/Max`, `status` (Behandeld → `:has:session_started_at`, Niet behandeld → `:has-no:…`), and `municipalityLabels`/`provinceLabels` — resolved to `search_location_id` uuids via `resolveLocationIdsForLabels` (SPARQL lookup of `prov:Location` by `rdfs:label`). Keep this in sync if the frontend query changes.
- **Street/distance (geo) filters** are reproduced via `:geo:address_geometry_coord` using the Lambert-72 coordinates and the resolved radius the frontend persists on the saved filter (`addressXLambert72`/`addressYLambert72`/`distanceKm` in `ext:filterData`, written by `filter-service.withResolvedCoordinates`). Note: the filter's `distance` is a `distanceList` option **id** (e.g. `"3"` → 10 km), not km — `distanceKm` is the resolved radius; the scan falls back to 50 km when it's absent. Filters saved **before** this (no stored coordinates) are **skipped** (counted as `unsupported`); re-saving back-fills the coordinates and radius.
- The keyword translation uses a fuzzy match for plain keywords; the frontend additionally supports AND/OR/NOT operators. Counts for operator-style keywords may differ slightly.
- The baseline `count` is computed by the **frontend** at save time; the scan recomputes with the **backend** translator. If the two disagree, the first scan after a save may notify or re-baseline spuriously — it self-corrects on subsequent runs since the scan re-baselines to its own count. To eliminate this, compute the baseline server-side in `createSavedFilter` instead of trusting the frontend `count`.
