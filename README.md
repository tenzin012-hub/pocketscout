# 🔍 PocketScout SMS Server

AI-powered SMS deal finder for Canadians. Powered by **Claude AI** + **Twilio**.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Create your `.env` file
```env
ANTHROPIC_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
PORT=3000
```

### 3. Run the server
```bash
npm start         # production
npm run dev       # development with auto-reload
```

---

## Twilio Setup

1. Sign up at [twilio.com](https://twilio.com) and buy a Canadian phone number (+1 area code)
2. Go to **Phone Numbers → Manage → Active Numbers**
3. Click your number → set **Messaging Webhook** to:
   ```
   https://your-server.com/sms
   ```
   Method: `HTTP POST`
4. Save. Done — Twilio will POST incoming SMS to your server.

---

## Deployment Options

### Option A — Railway (easiest, free tier)
```bash
# Install Railway CLI
npm i -g @railway/cli
railway login
railway init
railway up
```
Set your env vars in the Railway dashboard.

### Option B — Render
1. Push code to GitHub
2. Create new **Web Service** on render.com
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add env vars in dashboard

### Option C — VPS (DigitalOcean / Linode)
```bash
# On your server
git clone your-repo
cd pocketscout
npm install
# Install PM2 for process management
npm i -g pm2
pm2 start pocketscout-server.js --name pocketscout
pm2 save
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sms` | Twilio webhook — handles incoming SMS |
| `GET` | `/health` | Server status + active conversation count |
| `DELETE` | `/conversation/:phone` | Clear a user's conversation history |

---

## How It Works

```
User texts your number
        ↓
Twilio POSTs to /sms
        ↓
Server looks up conversation history
        ↓
Claude AI applies Scout Tier Logic:
  🏪 Tier 1 — Local Hero (independent shops)
  🍁 Tier 2 — Great Canadian (Canadian brands/retailers)
  💻 Tier 3 — Best Deal (Amazon, Walmart, Costco, etc.)
        ↓
Response split into 1-3 SMS parts
        ↓
Twilio sends each SMS with 1s delay
```

---

## Scaling for Production

- **Swap in-memory store** → Use Redis for conversation history across multiple server instances
- **Add a database** → Log all searches for analytics (MongoDB or PostgreSQL)
- **Rate limiting** → Add `express-rate-limit` to prevent abuse
- **Auth** → Validate Twilio webhook signatures for security

```bash
npm install redis express-rate-limit
```

Twilio signature validation (add to server):
```js
const { validateRequest } = require('twilio');
app.post('/sms', (req, res, next) => {
  const valid = validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    `https://your-domain.com/sms`,
    req.body,
    req.headers['x-twilio-signature']
  );
  if (!valid) return res.status(403).send('Forbidden');
  next();
});
```
