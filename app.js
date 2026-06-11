import { app, beforeExit } from 'mu';
import {
  resolveAccountFromSession,
  createSavedFilter,
  updateSavedFilter,
  listSavedFiltersForAccount,
  deleteSavedFilter,
  listAllNotifiableFilters,
  markFilterNotified,
  updateFilterSeenCount,
} from './helpers/queries';
import { countMatchingAgendaItems, usesGeoSearch, hasGeoCoordinates } from './helpers/search';
import { notifySavedFilterUpdate, notifyTestMessage } from './helpers/notifications';

async function requireAccount(req, res) {
  const sessionUri = req.headers['mu-session-id'];
  if (!sessionUri) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const resolved = await resolveAccountFromSession(sessionUri);
  if (!resolved) {
    res.status(401).json({ error: 'Session not found' });
    return null;
  }
  return resolved;
}

app.get('/', async function(req, res) {
  return res.status(200).json({ ok: true, title: 'MBP saved-filter notification service' });
});

app.post('/saved-filters', async function(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return;

  const attrs = req.body?.data?.attributes || req.body || {};
  const name = attrs.name || attrs.title;
  const filter = attrs.filter;
  const notify = typeof attrs.notify === 'boolean' ? attrs.notify : true;
  const count = attrs.count; // current result count the user sees — the notification baseline

  if (!filter || typeof filter !== 'object') {
    return res.status(400).json({ error: 'filter is required and must be an object' });
  }

  try {
    const saved = await createSavedFilter({ accountUri: account.accountUri, name, filter, notify, count });
    return res.status(201).json({ data: { type: 'saved-filters', id: saved.id, attributes: saved } });
  } catch (e) {
    console.error('create saved-filter failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.put('/saved-filters/:id', async function(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return;

  const attrs = req.body?.data?.attributes || req.body || {};
  const { name, filter, notify, count } = attrs;

  if (name === undefined && filter === undefined && notify === undefined && count === undefined) {
    return res.status(400).json({ error: 'at least one of name, filter, notify, count is required' });
  }
  if (filter !== undefined && (typeof filter !== 'object' || filter === null)) {
    return res.status(400).json({ error: 'filter must be an object' });
  }

  try {
    await updateSavedFilter({ accountUri: account.accountUri, filterId: req.params.id, name, filter, notify, count });
    return res.status(204).send();
  } catch (e) {
    console.error('update saved-filter failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/saved-filters', async function(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return;

  try {
    const filters = await listSavedFiltersForAccount(account.accountUri);
    return res.status(200).json({
      data: filters.map((f) => ({ type: 'saved-filters', id: f.id, attributes: f })),
    });
  } catch (e) {
    console.error('list saved-filters failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.delete('/saved-filters/:id', async function(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return;

  try {
    await deleteSavedFilter({ accountUri: account.accountUri, filterId: req.params.id });
    return res.status(204).send();
  } catch (e) {
    console.error('delete saved-filter failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Manual test endpoint — sends a simple notification to the signed-in user.
// Authenticated via mu-session-id; resolves the caller's RRN from the session.
app.post('/test-notification', async function(req, res) {
  const account = await requireAccount(req, res);
  if (!account) return;

  if (!account.rrn) {
    return res.status(409).json({
      error: 'no_rrn',
      message: 'No rijksregisternummer is stored for this account; cannot address a notification.',
    });
  }

  // TEST ONLY: optional server-side delay so you can close/background the app
  // before the notification is actually sent. Set TEST_NOTIFICATION_DELAY_MS (e.g. 15000).
  const delayMs = Number(process.env.TEST_NOTIFICATION_DELAY_MS) || 0;
  if (delayMs > 0) {
    console.log(`test-notification: waiting ${delayMs}ms before sending to ${account.rrn.slice(-4)}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  try {
    await notifyTestMessage({ rrn: account.rrn });
    return res.status(202).json({ ok: true });
  } catch (e) {
    console.error('test-notification failed', e);
    return res.status(502).json({ error: 'notification_failed', message: e.message });
  }
});

// Internal cron endpoint — must NOT be exposed via the dispatcher.
// Compares each filter's current match count against its stored high-water mark
// (ext:lastSeenCount) and notifies the owner about the positive delta.
app.post('/send-notifications', async function(req, res) {
  const startedAt = new Date();
  const summary = { scanned: 0, notified: 0, skipped: 0, baselined: 0, unsupported: 0, errors: 0 };

  let filters;
  try {
    filters = await listAllNotifiableFilters();
  } catch (e) {
    console.error('send-notifications: could not list filters', e);
    return res.status(500).json({ error: 'internal_error' });
  }

  for (const f of filters) {
    summary.scanned += 1;

    // Street/distance filters need stored coordinates to reproduce the geo search.
    // Older filters saved without coordinates can't be counted accurately — skip them.
    if (usesGeoSearch(f.filter) && !hasGeoCoordinates(f.filter)) {
      summary.unsupported += 1;
      console.log(`send-notifications: filter ${f.id} skipped (geo search without stored coordinates)`);
      continue;
    }

    try {
      const currentCount = await countMatchingAgendaItems(f.filter);
      const previousCount = f.lastSeenCount;

      // No baseline yet (e.g. filter saved before this feature): record one, don't notify.
      if (previousCount === null) {
        await updateFilterSeenCount(f.uri, currentCount);
        summary.baselined += 1;
        continue;
      }

      const delta = currentCount - previousCount;
      if (delta > 0) {
        await notifySavedFilterUpdate({
          rrn: f.rrn,
          filterId: f.id,
          filterName: f.name,
          newMatchCount: delta,
          filter: f.filter,
        });
        await markFilterNotified(f.uri, startedAt);
        summary.notified += 1;
        console.log(`Notified filter ${f.id} (${delta} new of ${currentCount})`);
      } else {
        summary.skipped += 1;
        console.log(`send-notifications: filter ${f.id} skipped (count ${currentCount} ≤ baseline ${previousCount}, no new items)`);
      }

      // Always re-baseline to the current count so the next run compares against it.
      if (currentCount !== previousCount) {
        await updateFilterSeenCount(f.uri, currentCount);
      }
    } catch (e) {
      summary.errors += 1;
      console.error(`send-notifications: filter ${f.id} failed`, e.message);
    }
  }

  console.log('send-notifications run complete', summary);
  return res.status(200).json({ ok: true, ...summary });
});

beforeExit();
