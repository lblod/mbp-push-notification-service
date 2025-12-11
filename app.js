import { sendNotification } from "./helpers/notifications";
import { addDeviceAndFilters, getAllFilters } from "./helpers/queries";
import { app, beforeExit } from 'mu';

app.get('/', async function(req, res) {
    return res.status(200).json({ ok: true, title: "MBP notification service" });
});

app.get('/send-notifications', async (req, res) => {
  try {
    const filters = await getAllFilters();

    for (const item of filters) {
      console.log(`Sending notification to device ${item.deviceId}`);
      console.log(`Filter:`, item.filterData);
      await sendNotification(item.deviceId, item.filterData);
    }

    return res.status(200).json({ ok: true, count: filters.length });
  } catch (err) {
    console.error('send-notifications error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/register-filter', async function(req, res) {
  try {
    const { deviceId, filter } = req.body.data.attributes;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    if (!filter) {
      return res.status(400).json({ error: 'filter is required' });
    }

    const device = await addDeviceAndFilters({ deviceId, filter  });
    console.log(device)
    return res.status(200).json({ ok: true, device });
  } catch (err) {
    console.error('register-filter error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

beforeExit();