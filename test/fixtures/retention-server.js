import { handlers, storage } from '../../demo/server.js';

process.on('message', async message => {
  if (message.type !== 'retire') return;
  try {
    // The browser has disconnected. Age only its session, then exercise the
    // sanctioned host retention surface rather than deleting rows in a fixture.
    for (let i = 0; i < 100 && storage.db.prepare('SELECT busy FROM session_retention WHERE session_id=?').get(message.id)?.busy; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    storage.db.prepare('UPDATE session_retention SET last_activity=1 WHERE session_id=?').run(message.id);
    const result = await handlers.retire({ before: 2, limit: 1 });
    process.send?.({ type: 'retired', result });
  } catch { process.send?.({ type: 'retired', error: 'retention-failed' }); }
});
