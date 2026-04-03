const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { TwitterApi } = require('twitter-api-v2');
const { google } = require('googleapis');
require('dotenv').config();

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database('autodma.db');
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  client_name TEXT,
  platform TEXT,
  content TEXT,
  content_type TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  posted_at TEXT,
  post_url TEXT,
  error_msg TEXT,
  image_url TEXT
);
    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT,
      platform TEXT,
      metric TEXT,
      value TEXT,
      recorded_at TEXT
    );
  `);
  console.log('[DB] SQLite ready');
} catch (e) {
  console.warn('[DB] SQLite not available, using in-memory store');
  const memStore = { queue: [], analytics: [] };
  db = {
    prepare: (sql) => ({
      all: (...args) => memStore.queue,
      get: (...args) => memStore.queue.find(q => q.id === args[0]),
      run: (...args) => {
        if (sql.includes('INSERT OR REPLACE')) {
          const existing = memStore.queue.findIndex(q => q.id === args[0]);
          const item = {
            id: args[0], client_id: args[1], client_name: args[2],
            platform: args[3], content: args[4], content_type: args[5],
            scheduled_date: args[6], scheduled_time: args[7],
            status: args[8], created_at: args[9], image_url: args[10]
          };
          if (existing >= 0) memStore.queue[existing] = item;
          else memStore.queue.push(item);
        } else if (sql.includes('UPDATE queue SET status=?')) {
          const item = memStore.queue.find(q => q.id === args[args.length - 1]);
          if (item) item.status = args[0];
        }
      }
    }),
    exec: () => {}
  };
}

const app = express();

// CORS — frontend ko allow karo
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ─── HEALTH CHECK ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'AutoDMA Backend Running',
    time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    timezone: 'IST (Asia/Kolkata)',
    version: '2.0'
  });
});

// ─── QUEUE APIS ──────────────────────────────────────────
app.get('/api/queue', (req, res) => {
  try {
    const items = db.prepare('SELECT * FROM queue ORDER BY scheduled_date, scheduled_time').all();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sync-queue', (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO queue
      (id, client_id, client_name, platform, content, content_type,
       scheduled_date, scheduled_time, status, created_at, image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    items.forEach(item => {
      insert.run(item.id, item.clientId, item.clientName, item.platform,
        item.text, item.contentType, item.scheduledDate, item.scheduledTime,
        item.status, item.createdAt, item.image_url);
    });
    res.json({ success: true, synced: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/queue/:id', (req, res) => {
  const { status, post_url, error_msg } = req.body;
  db.prepare('UPDATE queue SET status=?, post_url=?, error_msg=? WHERE id=?')
    .run(status, post_url || null, error_msg || null, req.params.id);
  res.json({ success: true });
});

app.post('/api/post-now/:id', async (req, res) => {
  const item = db.prepare('SELECT * FROM queue WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  try {
    const result = await postContent(item);
    db.prepare('UPDATE queue SET status="posted", post_url=?, posted_at=? WHERE id=?')
      .run(result.url || '', new Date().toISOString(), item.id);
    res.json({ success: true, result });
  } catch (err) {
    db.prepare('UPDATE queue SET status="failed", error_msg=? WHERE id=?')
      .run(err.message, item.id);
    res.status(500).json({ error: err.message });
  }
});

// ─── POSTING FUNCTIONS ───────────────────────────────────
async function postToFacebook(content) {
  if (!process.env.META_PAGE_ID || !process.env.META_PAGE_TOKEN) throw new Error('Meta credentials not set in .env');
  const res = await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: content, access_token: process.env.META_PAGE_TOKEN })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { url: `https://facebook.com/${data.id}` };
}

async function postToInstagram(content, imageUrl) {
  if (!process.env.INSTAGRAM_ACCOUNT_ID || !process.env.INSTAGRAM_ACCESS_TOKEN) throw new Error('Instagram credentials not set');
  if (!imageUrl) throw new Error('Instagram needs an image URL');
  const base = `https://graph.facebook.com/v19.0/${process.env.INSTAGRAM_ACCOUNT_ID}`;
  const token = process.env.META_PAGE_TOKEN;
  const container = await fetch(`${base}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption: content, access_token: token })
  }).then(r => r.json());
  if (container.error) throw new Error(container.error.message);
  await new Promise(r => setTimeout(r, 3000));
  const pub = await fetch(`${base}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: token })
  }).then(r => r.json());
  if (pub.error) throw new Error(pub.error.message);
  return { url: `https://instagram.com/p/${pub.id}` };
}

async function postToLinkedIn(content) {
  if (!process.env.LINKEDIN_ACCESS_TOKEN || !process.env.LINKEDIN_COMPANY_ID) throw new Error('LinkedIn credentials not set');
  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      author: `urn:li:organization:${process.env.LINKEDIN_COMPANY_ID}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: content },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    })
  });
  const data = await res.json();
  if (data.status >= 400) throw new Error(JSON.stringify(data));
  return { url: `https://linkedin.com/feed/update/${data.id}` };
}

async function postToTwitter(content) {
  if (!process.env.TWITTER_API_KEY) throw new Error('Twitter credentials not set');
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
  const tweets = content.split('\n---\n').filter(t => t.trim());
  let lastId = null;
  for (const text of tweets) {
    const params = { text: text.slice(0, 280) };
    if (lastId) params.reply = { in_reply_to_tweet_id: lastId };
    const tweet = await client.v2.tweet(params);
    lastId = tweet.data.id;
  }
  return { url: `https://x.com/i/web/status/${lastId}` };
}

async function postContent(item) {
  const content = item.content || item.text;
  switch (item.platform) {
    case 'facebook':  return postToFacebook(content);
    case 'instagram': return postToInstagram(content, item.image_url);
    case 'linkedin':  return postToLinkedIn(content);
    case 'twitter':   return postToTwitter(content);
    default: throw new Error(`Platform not supported: ${item.platform}`);
  }
}

// ─── CRON SCHEDULER ──────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const istDate = istNow.toISOString().split('T')[0];
  const istTime = istNow.toTimeString().slice(0, 5);

  let due = [];
  try {
    due = db.prepare(`SELECT * FROM queue WHERE status='scheduled' AND scheduled_date<=? AND scheduled_time<=? LIMIT 5`).all(istDate, istTime);
  } catch (e) {}

  for (const item of due) {
    console.log(`[Cron] Posting: ${item.platform} - ${item.client_name}`);
    try {
      db.prepare('UPDATE queue SET status=? WHERE id=?').run('posting', item.id);
      const result = await postContent(item);
      db.prepare('UPDATE queue SET status="posted", post_url=?, posted_at=? WHERE id=?')
        .run(result.url, new Date().toISOString(), item.id);
      console.log(`[OK] ${item.platform}: ${result.url}`);
    } catch (err) {
      db.prepare('UPDATE queue SET status="failed", error_msg=? WHERE id=?').run(err.message, item.id);
      console.error(`[FAIL] ${item.platform}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}, { timezone: 'Asia/Kolkata' });
// ✅ Instagram Webhook Verification (GET)
app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Webhook Verified!');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
});

// ✅ Instagram Events Receive Karna (POST)
app.post('/webhook/instagram', (req, res) => {
  console.log('📩 Instagram Event:', JSON.stringify(req.body));
  res.status(200).send('EVENT_RECEIVED');
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n AutoDMA Backend v2.0`);
  console.log(` Port: ${PORT}`);
  console.log(` Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log(` Scheduler: Active (every 5 min)\n`);
});
