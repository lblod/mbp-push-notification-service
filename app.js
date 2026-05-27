import { app, beforeExit } from 'mu';
import {
  resolveAccountFromSession,
  createSavedFilter,
  updateSavedFilter,
  listSavedFiltersForAccount,
  deleteSavedFilter,
  listAllNotifiableFilters,
  markFilterNotified,
} from './helpers/queries';
import { countMatchingAgendaItems } from './helpers/search';
import { notifySavedFilterUpdate } from './helpers/notifications';

const DEFAULT_LOOKBACK_HOURS = 24;

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

  if (!filter || typeof filter !== 'object') {
    return res.status(400).json({ error: 'filter is required and must be an object' });
  }

  try {
    const saved = await createSavedFilter({ accountUri: account.accountUri, name, filter, notify });
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
  const { name, filter, notify } = attrs;

  if (name === undefined && filter === undefined && notify === undefined) {
    return res.status(400).json({ error: 'at least one of name, filter, notify is required' });
  }
  if (filter !== undefined && (typeof filter !== 'object' || filter === null)) {
    return res.status(400).json({ error: 'filter must be an object' });
  }

  try {
    await updateSavedFilter({ accountUri: account.accountUri, filterId: req.params.id, name, filter, notify });
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

// Internal cron endpoint — must NOT be exposed via the dispatcher.
app.post('/send-notifications', async function(req, res) {
  const startedAt = new Date();
  const summary = { scanned: 0, notified: 0, skipped: 0, errors: 0 };

  let filters;
  try {
    filters = await listAllNotifiableFilters();
  } catch (e) {
    console.error('send-notifications: could not list filters', e);
    return res.status(500).json({ error: 'internal_error' });
  }

  for (const f of filters) {
    summary.scanned += 1;
    const since = f.lastNotifiedAt
      || new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000).toISOString();

    try {
      const count = await countMatchingAgendaItems(f.filter, since);
      if (count > 0) {
        await notifySavedFilterUpdate({
          rrn: f.rrn,
          filterId: f.id,
          filterName: f.name,
          newMatchCount: count,
        });
        await markFilterNotified(f.uri, startedAt);
        summary.notified += 1;
        console.log(`Notified filter ${f.id} (${count} new matches)`);
      } else {
        summary.skipped += 1;
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
