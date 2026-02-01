// Production version with Redis support for Vercel deployment
// This file shows how to add Redis for global real-time connections

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

// Initialize Redis client
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
})

redis.connect().catch(console.error)

// Using Ably or Pusher as alternative to Redis for Vercel
// These are easier to set up and handle SSE limitations automatically

interface RoomState {
  strokes: Stroke[]
  operations: Operation[]
  redoStack: Operation[]
  users: Map<string, User>
  cursors: Map<string, UserCursor>
}

async function getRoom(roomId: string): Promise<RoomState> {
  const key = `room:${roomId}`
  const data = await redis.get(key)
  
  if (data) {
    const parsed = JSON.parse(data)
    return {
      ...parsed,
      users: new Map(parsed.users),
      cursors: new Map(parsed.cursors),
    }
  }
  
  return {
    strokes: [],
    operations: [],
    redoStack: [],
    users: new Map(),
    cursors: new Map(),
  }
}

async function saveRoom(roomId: string, room: RoomState) {
  const key = `room:${roomId}`
  const data = {
    ...room,
    users: Array.from(room.users.entries()),
    cursors: Array.from(room.cursors.entries()),
  }
  await redis.setEx(key, 86400, JSON.stringify(data)) // Expire after 24 hours
}

async function broadcastToRoom(roomId: string, message: WSMessage) {
  // Using Redis Pub/Sub for real-time broadcasts
  await redis.publish(`room:${roomId}`, JSON.stringify(message))
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const roomId = searchParams.get('roomId') || 'default'
  const userName = searchParams.get('userName') || 'Anonymous'
  const userId = searchParams.get('userId') || generateId()

  // Get room state from Redis
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

  // Subscribe to room broadcasts
  const subscriber = redis.duplicate()
  await subscriber.connect()
  
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Send initial sync
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

      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(syncMessage)}\n\n`))

      // Broadcast user joined
      await broadcastToRoom(roomId, {
        type: 'user_joined',
        roomId,
        userId,
        payload: { user },
        timestamp: Date.now(),
      })

      // Listen for broadcasts
      await subscriber.subscribe(`room:${roomId}`, (message: string) => {
        const data = `data: ${message}\n\n`
        controller.enqueue(encoder.encode(data))
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
    },
  })
}

export async function POST(request: NextRequest) {
  try {
    const message: WSMessage = await request.json()
    const { roomId, userId, type, payload } = message

    if (!roomId || !userId || !type) {
      return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    const room = await getRoom(roomId)
    const user = room.users.get(userId)

    if (!user) {
      return Response.json({ success: false, error: 'User not found in room' }, { status: 401 })
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

        // Broadcast stroke start to all users in room
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

        // Broadcast update
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
          color: '#0000ff',
          name: 'User',
          isDrawing,
          lastUpdate: Date.now(),
        })

        await broadcastToRoom(roomId, {
          type: 'cursor_move',
          roomId,
          userId,
          payload: { userId, x, y, isDrawing },
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
    }

    return Response.json({ success: true })
  } catch (error) {
    console.error('Error processing message:', error)
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
