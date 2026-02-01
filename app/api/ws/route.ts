// Redis-powered real-time WebSocket API for Vercel deployment
// Ultra-optimized for low latency: <50ms end-to-end

import { NextRequest } from 'next/server'
import { createClient } from 'redis'
import {
  Stroke,
  User,
  UserCursor,
  WSMessage,
  Operation,
  ToolType,
  generateId,
  getRandomUserColor,
} from '@/lib/drawing-types'

// Redis client with aggressive connection pooling for latency
const redis = createClient({
  url: process.env.REDIS_URL || 'rediss://default:password@host:6379',
  socket: {
    reconnectStrategy: (retries) => {
      const delay = Math.min(retries * 10, 100) // Faster reconnect
      return delay
    },
    keepAlive: 30000, // Keep connection alive
    noDelay: true, // TCP_NODELAY for low latency
  },
  commandsQueueBehaviour: 'FLUSH', // Send commands immediately
})

redis.connect().catch((err) => console.error('Redis failed:', err))
redis.on('error', (err) => console.error('Redis error:', err))
redis.on('connect', () => console.log('✅ Redis connected'))

interface RoomState {
  strokes: Stroke[]
  operations: Operation[]
  redoStack: Operation[]
  users: Map<string, User>
  cursors: Map<string, UserCursor>
}

// Get room from Redis
async function getRoom(roomId: string): Promise<RoomState> {
  try {
    const key = `room:${roomId}`
    const data = await redis.get(key)
    if (data && typeof data === 'string') {
      const parsed = JSON.parse(data)
      return {
        ...parsed,
        users: new Map(parsed.users || []),
        cursors: new Map(parsed.cursors || []),
      }
    }
  } catch (error) {
    console.error('Get room error:', error)
  }
  return {
    strokes: [],
    operations: [],
    redoStack: [],
    users: new Map(),
    cursors: new Map(),
  }
}

// Save room to Redis (24h expiry)
async function saveRoom(roomId: string, room: RoomState): Promise<void> {
  try {
    const key = `room:${roomId}`
    const data = {
      strokes: room.strokes,
      operations: room.operations,
      redoStack: room.redoStack,
      users: Array.from(room.users.entries()),
      cursors: Array.from(room.cursors.entries()),
    }
    await redis.setEx(key, 86400, JSON.stringify(data))
  } catch (error) {
    console.error('Save room error:', error)
  }
}

// Broadcast via Redis Pub/Sub
async function broadcastToRoom(roomId: string, message: WSMessage): Promise<void> {
  try {
    await redis.publish(`room:${roomId}:messages`, JSON.stringify(message))
  } catch (error) {
    console.error('Broadcast error:', error)
  }
}

// SSE GET endpoint
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const roomId = searchParams.get('roomId') || 'default'
  const userName = searchParams.get('userName') || 'Anonymous'
  const userId = searchParams.get('userId') || generateId()

  const room = await getRoom(roomId)

  if (room.users.size >= 100) {
    return new Response('Room is full', { status: 503 })
  }

  const user: User = {
    id: userId,
    name: userName,
    color: getRandomUserColor(),
    joinedAt: Date.now(),
    isOnline: true,
  }
  room.users.set(userId, user)
  await saveRoom(roomId, room)

  const subscriber = redis.duplicate()
  await subscriber.connect()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()

      // Initial sync
      const syncMessage: WSMessage = {
        type: 'sync_state',
        roomId,
        userId,
        payload: {
          strokes: room.strokes,
          users: Array.from(room.users.values()),
          cursors: Array.from(room.cursors.values()),
          yourUser: user,
          operations: room.operations,
          canUndo: room.operations.length > 0,
          canRedo: room.redoStack.length > 0,
        },
        timestamp: Date.now(),
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(syncMessage)}\n\n`))

      // Broadcast join
      await broadcastToRoom(roomId, {
        type: 'user_joined',
        roomId,
        userId,
        payload: { user },
        timestamp: Date.now(),
      })

      // Keep-alive heartbeat (send ping every 15s to prevent SSE timeout, lower than 20s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`))
        } catch (e) {
          clearInterval(heartbeat)
        }
      }, 15000)

      // Subscribe to room channel
      await subscriber.subscribe(`room:${roomId}:messages`, (message) => {
        try {
          controller.enqueue(encoder.encode(`data: ${message}\n\n`))
        } catch (e) {
          clearInterval(heartbeat)
          console.error('Send error:', e)
        }
      })
    },

    async cancel() {
      const room = await getRoom(roomId)
      room.users.delete(userId)
      room.cursors.delete(userId)
      await saveRoom(roomId, room)
      await subscriber.unsubscribe()
      await subscriber.disconnect()

      await broadcastToRoom(roomId, {
        type: 'user_left',
        roomId,
        userId,
        payload: { userId },
        timestamp: Date.now(),
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

// POST endpoint for drawing events
export async function POST(request: NextRequest) {
  try {
    const message: WSMessage = await request.json()
    const { roomId, userId, type, payload } = message

    if (!roomId || !userId || !type) {
      return Response.json(
        { success: false, error: 'Missing fields' },
        { status: 400 }
      )
    }

    const room = await getRoom(roomId)
    const user = room.users.get(userId)

    if (!user) {
      return Response.json(
        { success: false, error: 'User not in room' },
        { status: 401 }
      )
    }

    switch (type) {
      case 'stroke_start': {
        const { strokeId, point, color, width, tool } = payload as any
        const newStroke: Stroke = {
          id: strokeId,
          userId,
          points: [point],
          color,
          width: Math.max(1, Math.min(100, width || 4)),
          tool,
          timestamp: Date.now(),
          startPoint: point,
        }
        await broadcastToRoom(roomId, {
          type: 'stroke_start',
          roomId,
          userId,
          payload: newStroke,
          timestamp: Date.now(),
        })
        break
      }

      case 'stroke_update': {
        const { strokeId, points, endPoint } = payload as any
        if (!Array.isArray(points) || points.length === 0) {
          return Response.json({ success: false }, { status: 400 })
        }
        // Send all points for maximum responsiveness
        await broadcastToRoom(roomId, {
          type: 'stroke_update',
          roomId,
          userId,
          payload: { strokeId, points, endPoint },
          timestamp: Date.now(),
        })
        break
      }

      case 'stroke_end': {
        const { strokeId, stroke } = payload as any
        room.strokes.push(stroke)
        const operation: Operation = {
          id: generateId(),
          type: 'stroke_add',
          stroke,
          userId,
          userName: user?.name || 'Unknown',
          timestamp: Date.now(),
        }
        room.operations.push(operation)
        room.redoStack = []
        await saveRoom(roomId, room)

        await broadcastToRoom(roomId, {
          type: 'stroke_end',
          roomId,
          userId,
          payload: { strokeId, stroke, operation, canUndo: true, canRedo: false },
          timestamp: Date.now(),
        })
        break
      }

      case 'cursor_move': {
        const { x, y, isDrawing } = payload as any
        room.cursors.set(userId, {
          userId,
          x,
          y,
          color: user.color,
          name: user.name,
          isDrawing,
          lastUpdate: Date.now(),
        })
        await broadcastToRoom(roomId, {
          type: 'cursor_move',
          roomId,
          userId,
          payload: { userId, x, y, isDrawing, color: user.color, name: user.name },
          timestamp: Date.now(),
        })
        break
      }

      case 'undo': {
        if (room.operations.length > 0) {
          const op = room.operations.pop()!
          room.redoStack.push(op)
          await saveRoom(roomId, room)
          await broadcastToRoom(roomId, {
            type: 'undo',
            roomId,
            userId,
            payload: { operation: op, canUndo: room.operations.length > 0, canRedo: true },
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'redo': {
        if (room.redoStack.length > 0) {
          const op = room.redoStack.pop()!
          room.operations.push(op)
          await saveRoom(roomId, room)
          await broadcastToRoom(roomId, {
            type: 'redo',
            roomId,
            userId,
            payload: { operation: op, canUndo: true, canRedo: room.redoStack.length > 0 },
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'clear': {
        room.strokes = []
        room.operations = []
        room.redoStack = []
        await saveRoom(roomId, room)
        await broadcastToRoom(roomId, {
          type: 'clear',
          roomId,
          userId,
          payload: {},
          timestamp: Date.now(),
        })
        break
      }
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error('POST error:', error)
    return Response.json({ success: false }, { status: 500 })
  }
}

