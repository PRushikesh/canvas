# Vercel Deployment Guide

## Current Status: ❌ NOT Ready for Vercel

Your current app uses **in-memory state** which doesn't work on Vercel's serverless architecture.

---

## The Problem Explained

### 1. **Serverless = No Memory Persistence**
- Vercel runs each function independently
- Every request might hit a different server
- State stored in `const rooms = new Map()` gets lost instantly
- Users in different requests can't see each other's drawings

### 2. **SSE Connection Timeout**
- Vercel Functions timeout after:
  - **Free Plan**: ~25 seconds
  - **Pro Plan**: ~60 seconds
  - **Enterprise**: ~5 minutes
- SSE streams need to stay open indefinitely
- Connection will drop and users disconnect

### 3. **No Shared State Between Instances**
- Server 1 handles User A → stores in its memory
- Server 2 handles User B → stores in its memory
- User A and User B can't see each other's actions

---

## Solution 1: Use Redis (Recommended)

### Setup

1. **Get Redis instance**:
   - [Upstash](https://upstash.com) - Free tier available
   - [Redis Cloud](https://redis.com/try-free/) - Free tier
   - [Heroku Redis](https://www.heroku.com/redis) - Paid

2. **Install Redis client**:
```bash
npm install redis
```

3. **Set environment variable on Vercel**:
```
REDIS_URL=redis://default:password@host:port
```

4. **Use the Redis version**:
```bash
# Rename current
mv app/api/ws/route.ts app/api/ws/route-local.ts

# Use Redis version
mv app/api/ws/redis-route.ts app/api/ws/route.ts
```

5. **Deploy to Vercel**:
```bash
git add .
git commit -m "Add Redis for Vercel deployment"
git push
```

### How It Works
- All servers connect to **same Redis instance**
- Room state stored in Redis (persists between requests)
- Broadcasts go through Redis Pub/Sub
- **Global connection**: Any user can join from anywhere
- **Data persists**: Drawings saved until room expires (24 hours)

---

## Solution 2: Use Ably (Even Easier)

**Ably handles SSE limitations automatically**

### Setup

1. **Sign up**: https://ably.com (free tier: 6M messages/month)

2. **Install**:
```bash
npm install ably
```

3. **Create Ably version**:

```typescript
// app/api/ws/route.ts
import Ably from 'ably'
import { NextRequest } from 'next/server'

const client = new Ably.Rest({ key: process.env.ABLY_API_KEY })

export async function POST(request: NextRequest) {
  const message = await request.json()
  const { roomId, type, payload } = message

  // Publish to Ably channel
  const channel = client.channels.get(`drawing:${roomId}`)
  await channel.publish(type, payload)

  return Response.json({ success: true })
}
```

4. **Update client to use Ably**:

```typescript
// hooks/use-collaborative-canvas.ts
import Ably from 'ably/promises'

const client = new Ably.Realtime(process.env.NEXT_PUBLIC_ABLY_KEY!)
const channel = client.channels.get(`drawing:${roomId}`)

await channel.subscribe((message: any) => {
  // Handle incoming message
  setState(prev => ({ ...prev, ... }))
})
```

**Advantages**:
- ✅ Handles all connection issues
- ✅ Global by default
- ✅ Free tier includes 6M messages
- ✅ No server maintenance

---

## Solution 3: Use WebSocket Provider (Easiest)

Use a pre-built service like:
- **[Pusher](https://pusher.com)** - Free tier included
- **[Socket.io Cloud](https://socket.io)** - Managed WebSocket
- **[Supabase Realtime](https://supabase.com)** - Built-in with Postgres

---

## Global Connection Explained

### Current (Local)
```
User A (localhost:3000) → Server (localhost:3000) ← User B
```
Only works on same machine

### With Redis on Vercel
```
User A (anyplace.com) → Vercel Edge → Redis ← Vercel Edge ← User B (anywhere)
```
Works globally, any user can join from anywhere

### How Users Connect
1. User joins room: `https://yourapp.vercel.app?room=design-collab`
2. Client connects to `/api/ws?roomId=design-collab`
3. Server adds user to Redis
4. Redis broadcasts to all users in that room
5. **Anyone with the room ID can join from anywhere**

---

## Testing Global Connection

### Local Testing (Before Deployment)
```bash
# Terminal 1: Start app
npm run dev

# Terminal 2: User A in browser
open http://localhost:3000?room=test

# Terminal 3: User B in browser
open http://localhost:3000?room=test

# Draw in User A's tab → Should appear in User B's tab
```

### After Vercel Deployment
```
User A: https://yourapp.vercel.app?room=test
User B: https://yourapp.vercel.app?room=test

# Draw in any browser, any location → Other users see instantly
```

---

## Deployment Checklist

### ✅ Before Deployment

- [ ] Choose solution (Redis recommended)
- [ ] Sign up for Redis/Ably service
- [ ] Add `REDIS_URL` or `ABLY_KEY` to `.env.local`
- [ ] Test locally with 2 browser tabs
- [ ] Update `package.json` with new dependencies
- [ ] Test undo/redo works
- [ ] Test cursor tracking works

### ✅ Deploy to Vercel

```bash
# Add to Vercel environment variables
vercel env add REDIS_URL  # Paste your Redis URL
# or
vercel env add ABLY_API_KEY  # Paste your Ably key

# Deploy
vercel deploy
```

### ✅ After Deployment

- [ ] Open https://yourapp.vercel.app?room=test1
- [ ] Open https://yourapp.vercel.app?room=test1 in another browser
- [ ] Draw in first browser → Check second browser
- [ ] Try undo/redo
- [ ] Try cursor movement

---

## Troubleshooting

### "Connection closed" errors
- SSE timeout is hitting
- Solution: Use Redis or Ably instead

### "Users can't see each other"
- In-memory state being used
- Check that `redis-route.ts` is renamed to `route.ts`

### "Redis connection failed"
- Check `REDIS_URL` environment variable
- Verify URL format: `redis://default:password@host:port`
- Check firewall/network access

### "Message not delivered"
- Verify Redis Pub/Sub is subscribed
- Check network latency (check DevTools Network tab)
- Try latency optimization again (see PERFORMANCE_OPTIMIZATION.md)

---

## Cost Estimate (Monthly)

| Solution | Free Tier | Paid |
|----------|-----------|------|
| Upstash Redis | 10,000 commands | $0.20/10k commands |
| Redis Cloud | 30MB database | $15/month+ |
| Ably | 6M messages | $0.08/M messages |
| Vercel Function | Included | Included |

**Recommendation**: Start with Redis free tier or Ably (both include generous free tier)

---

## Next Steps

1. **If using Redis**:
   - Sign up at [Upstash](https://upstash.com)
   - Copy Redis URL
   - Add to Vercel environment
   - Deploy

2. **If using Ably**:
   - Sign up at [Ably](https://ably.com)
   - Copy API key
   - Install Ably SDK
   - Update client to use Ably channels

3. **After deployment**:
   - Share link: `https://yourapp.vercel.app?room=teamname`
   - Anyone with link can collaborate globally
   - Drawings persist for 24 hours

---

## Production Considerations

### Security
- Add authentication for private rooms
- Validate room IDs
- Rate limit API calls
- Encrypt sensitive data in Redis

### Persistence
- Current: 24-hour expiry
- Add database for permanent storage
- Use Supabase or Firebase for backup

### Scalability
- Redis can handle 100+ concurrent users
- For 1000+ users, use Redis Cluster
- Ably handles scaling automatically

---

## Commands for Quick Start

```bash
# Install Redis client
npm install redis

# Rename current local version
mv app/api/ws/route.ts app/api/ws/route-local.ts
cp app/api/ws/redis-route.ts app/api/ws/route.ts

# Add Vercel environment variable (replace with your URL)
vercel env add REDIS_URL redis://...

# Deploy
git add .
git commit -m "Add Redis for Vercel deployment"
git push

# Vercel auto-deploys, or manually:
vercel deploy --prod
```

---

## Key Takeaway

**Your current app works great locally but needs Redis (or Ably) for Vercel to:**
1. ✅ Keep state between requests
2. ✅ Connect users globally
3. ✅ Handle SSE connections properly
4. ✅ Scale to 100+ concurrent users

Choose Redis if you want control, choose Ably if you want simplicity!
