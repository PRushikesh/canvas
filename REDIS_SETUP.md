# Redis Setup Complete ✅

## Your Upstash Redis is ready!

### Credentials Set
- ✅ REDIS_URL configured
- ✅ .env.local created for local dev
- ✅ route.ts updated to use Redis
- ✅ Real-time with Pub/Sub enabled

---

## Deploy to Vercel (3 steps)

### Step 1: Add Environment Variables
```bash
vercel env add REDIS_URL
# Paste: rediss://default:AVUwAAIncDFiYTJiNmYwN2RkM2E0MTUyODczOTIzMWZmMTVjNDdkOHAxMjE4MDg@saved-cicada-21808.upstash.io:6379

vercel env add UPSTASH_REDIS_REST_URL
# Paste: https://saved-cicada-21808.upstash.io

vercel env add UPSTASH_REDIS_REST_TOKEN
# Paste: AVUwAAIncDFiYTJiNmYwN2RkM2E0MTUyODczOTIzMWZmMTVjNDdkOHAxMjE4MDg
```

### Step 2: Deploy
```bash
git add .
git commit -m "Add Redis for real-time collaboration"
git push
```

### Step 3: Test
```
Open: https://yourapp.vercel.app?room=test
In another browser: https://yourapp.vercel.app?room=test
Both should sync in real-time ✅
```

---

## Test Locally First

```bash
npm run dev
```

Open two tabs:
- Tab 1: http://localhost:3000?room=collab
- Tab 2: http://localhost:3000?room=collab

Draw in Tab 1 → Should appear in Tab 2 instantly ✅

---

## How Real-Time Works Now

```
User A draws
    ↓
Sends to /api/ws (POST)
    ↓
Redis stores state
    ↓
Redis Pub/Sub broadcasts to all users in room
    ↓
User B receives via SSE
    ↓
Drawing appears instantly ⚡
```

---

## Troubleshooting

### "Redis connection failed"
- Check REDIS_URL is correct
- Verify credentials in .env.local
- Test: `redis-cli --tls -u <REDIS_URL> PING`

### "Connection closed" after 60 seconds
- SSE timeout - make sure Redis Pub/Sub is running
- Check cloud logs for errors

### "Users can't see each other"
- Verify roomId is the same
- Check Redis connection is active
- Restart dev server

---

## Next: Make it Persistent (Optional)

Want to save drawings permanently?
1. Add Supabase Postgres
2. On stroke_end, save to database
3. On GET, load from database

Current setup: Temporary (24h expiry) ✅
Suggested: Permanent storage for production

---

**You're ready to deploy! 🚀**

Test locally → Push to GitHub → Auto-deploys to Vercel
