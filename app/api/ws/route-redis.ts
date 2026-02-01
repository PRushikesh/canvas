// Redis-powered WebSocket for real-time collaboration
// Works with Upstash Redis on Vercel (serverless environment)

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

// Create Redis client - uses REDIS_URL from environment
const redis = createClient({
  url: process.env.REDIS_URL || 'rediss://default:password@host:6379',
  socket: {
    reconnectStrategy: (retries) => {
      const delay = Math.min(retries * 50, 500)
      return delay
    },
  },
})

// Connect to Redis
redis.connect().catch((err) => {
  console.error('Redis connection failed:', err)
})

redis.on('error', (err) => console.error('Redis error:', err))
redis.on('connect', () => console.log('✅ Redis connected'))

interface RoomState {
  strokes: Stroke[]
  operations: Operation[]
  redoStack: Operation[]
  users: Map<string, User>
  cursors: Map<string, UserCursor>
}

// Get or create room from Redis
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
    console.error('Error getting room:', error)
  }

  return {
    strokes: [],
    operations: [],
    redoStack: [],
    users: new Map(),
    cursors: new Map(),
  }
}

// Save room to Redis (expires after 24 hours)
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
    console.error('Error saving room:', error)
  }
}

// Broadcast message to all users in room via Redis Pub/Sub
async function broadcastToRoom(roomId: string, message: WSMessage): Promise<void> {
  try {
    const channel = `room:${roomId}:messages`
    await redis.publish(channel, JSON.stringify(message))
  } catch (error) {
    console.error('Error broadcasting:', error)
  }
}

// SSE endpoint for receiving real-time updates
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const roomId = searchParams.get('roomId') || 'default'
  const userName = searchParams.get('userName') || 'Anonymous'
  const userId = searchParams.get('userId') || generateId()

  // Get or create room
  const room = await getRoom(roomId)

  // Check room limit
  if (room.users.size >= 100) {
    return new Response('Room is full', { status: 503 })
  }

  // Create new user
  const user: User = {
    id: userId,
    name: userName,
    color: getRandomUserColor(),
    joinedAt: Date.now(),
    isOnline: true,
  }
  room.users.set(userId, user)

  // Save updated room
  await saveRoom(roomId, room)

  // Subscribe to room updates via Redis Pub/Sub
  const subscriber = redis.duplicate()
  await subscriber.connect()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()

      // Send initial sync state
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

      // Broadcast user joined
      await broadcastToRoom(roomId, {
        type: 'user_joined',
        roomId,
        userId,
        payload: { user },
        timestamp: Date.now(),
      })

      // Listen to Redis Pub/Sub channel
      const channel = `room:${roomId}:messages`
      await subscriber.subscribe(channel, (message) => {
        try {
          const data = `data: ${message}\n\n`
          controller.enqueue(encoder.encode(data))
        } catch (error) {
          console.error('Error sending message:', error)
        }
      })
    },

    async cancel() {
      // Clean up when client disconnects
      const room = await getRoom(roomId)
      room.users.delete(userId)
      room.cursors.delete(userId)

      await saveRoom(roomId, room)
      await subscriber.unsubscribe()
      await subscriber.disconnect()

      // Broadcast user left
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
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const room = await getRoom(roomId)
    const user = room.users.get(userId)

    if (!user) {
      return Response.json(
        { success: false, error: 'User not found in room' },
        { status: 401 }
      )
    }

    switch (type) {
      case 'stroke_start': {
        const { strokeId, point, color, width, tool } = payload as any
        const validWidth = Math.max(1, Math.min(100, width || 4))

        const newStroke: Stroke = {
          id: strokeId,
          userId,
          points: [point],
          color,
          width: validWidth,
          tool,
          timestamp: Date.now(),
          startPoint: point,
        }

        // Broadcast immediately
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

        // Validate points
        if (!Array.isArray(points) || points.length === 0) {
          return Response.json(
            { success: false, error: 'Invalid points' },
            { status: 400 }
          )
        }

        // Broadcast with limited points to reduce latency
        await broadcastToRoom(roomId, {
          type: 'stroke_update',
          roomId,
          userId,
          payload: { strokeId, points: points.slice(0, 20), endPoint },
          timestamp: Date.now(),
        })
        break
      }

      case 'stroke_end': {
        const { strokeId, stroke } = payload as any

        // Save stroke to room
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

        // Broadcast completion
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

        // Validate coordinates
        if (typeof x !== 'number' || typeof y !== 'number') {
          return Response.json(
            { success: false, error: 'Invalid coordinates' },
            { status: 400 }
          )
        }

        // Update cursor
        room.cursors.set(userId, {
          userId,
          x,
          y,
          color: user.color,
          name: user.name,
          isDrawing,
          lastUpdate: Date.now(),
        })

        // Broadcast cursor position
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
          const operation = room.operations.pop()!
          room.redoStack.push(operation)
          await saveRoom(roomId, room)

          await broadcastToRoom(roomId, {
            type: 'undo',
            roomId,
            userId,
            payload: { operation, canUndo: room.operations.length > 0, canRedo: true },
            timestamp: Date.now(),
          })
        }
        break
      }

      case 'redo': {
        if (room.redoStack.length > 0) {
          const operation = room.redoStack.pop()!
          room.operations.push(operation)
          await saveRoom(roomId, room)

          await broadcastToRoom(roomId, {
            type: 'redo',
            roomId,
            userId,
            payload: { operation, canUndo: true, canRedo: room.redoStack.length > 0 },
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

      case 'notification': {
        await broadcastToRoom(roomId, {
          type: 'notification',
          roomId,
          userId,
          payload,
          timestamp: Date.now(),
        })
        break
      }
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error('POST error:', error)
    return Response.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
