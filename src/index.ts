/**
 * Cloudflare Worker Backend for Chatter3
 * Features: Auth, Matching Queue, and Native WebRTC Signaling
 */

interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
}

// Standard CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Helper: UUID Generator
const uuid = () => crypto.randomUUID();

// --- 1. SIGNALING SERVER (Durable Object) ---
// This acts as the "Meeting Room" that relays messages between two browsers
export class SignalingServer implements DurableObject {
  state: DurableObjectState;
  sessions: Set<WebSocket>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sessions = new Set();
  }

  async fetch(request: Request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    // Relay the message to the OTHER person in the room
    for (const otherWs of this.sessions) {
      if (otherWs !== ws) {
        try {
          otherWs.send(message);
        } catch (e) {
          this.sessions.delete(otherWs);
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }
}

// --- 2. MAIN WORKER API ---
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- AUTH ROUTES ---

    // Login (Mock/Email)
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const { email } = await request.json() as any;
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      
      if (!user) {
        return Response.json({ success: false, error: 'User not found' }, { headers: corsHeaders });
      }
      return Response.json({ success: true, user }, { headers: corsHeaders });
    }

    // Register (Email)
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      const { email, username, english_level } = await request.json() as any;
      const newId = uuid();
      try {
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, english_level, points, created_at)
          VALUES (?, ?, ?, 'google_oauth_user', ?, 100, datetime('now'))
        `).bind(newId, username, email, english_level || 'beginner').run();
        
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(newId).first();
        return Response.json({ success: true, user }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ success: false, error: 'User already exists' }, { headers: corsHeaders });
      }
    }

    // Google Auth (Upsert: Login if exists, Register if not)
    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      const { credential } = await request.json() as any;
      
      try {
        // Decode JWT (In prod, verify signature with Google's keys)
        const parts = credential.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const email = payload.email;
        const name = payload.name || email.split('@')[0];

        // 1. Check if user exists
        let user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

        if (!user) {
          // 2. Create user if not exists
          const newId = uuid();
          await env.DB.prepare(`
            INSERT INTO users (id, username, email, password_hash, english_level, points, created_at)
            VALUES (?, ?, ?, 'google_oauth_user', 'beginner', 100, datetime('now'))
          `).bind(newId, name, email).run();
          
          user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(newId).first();
        }

        return Response.json({ success: true, user }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ success: false, error: 'Invalid Google Token' }, { headers: corsHeaders });
      }
    }

    // --- MATCHING ROUTES ---

    // Join Queue
    if (url.pathname === '/api/matching/join' && request.method === 'POST') {
      const { user_id, english_level } = await request.json() as any;

      // Find a waiting partner
      const match = await env.DB.prepare(`
        SELECT * FROM matching_queue 
        WHERE english_level = ? AND user_id != ? 
        ORDER BY joined_at ASC LIMIT 1
      `).bind(english_level, user_id).first();

      if (match) {
        // Match found! Create session.
        const sessionId = uuid();
        const partnerId = match.user_id as string;
        
        await env.DB.prepare(`
          INSERT INTO sessions (id, user1_id, user2_id, english_level, status, created_at)
          VALUES (?, ?, ?, ?, 'active', datetime('now'))
        `).bind(sessionId, user_id, partnerId, english_level).run();

        // Remove partner from queue
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(partnerId).run();

        return Response.json({ success: true, matched: true, session_id: sessionId }, { headers: corsHeaders });
      } else {
        // No match, add to queue (ensure unique)
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();
        await env.DB.prepare(`
          INSERT INTO matching_queue (user_id, english_level, joined_at)
          VALUES (?, ?, datetime('now'))
        `).bind(user_id, english_level).run();

        return Response.json({ success: true, matched: false }, { headers: corsHeaders });
      }
    }

    // Check Session Status (Polling)
    if (url.pathname.startsWith('/api/matching/session/')) {
      const userId = url.pathname.split('/').pop();
      
      const session: any = await env.DB.prepare(`
        SELECT * FROM sessions 
        WHERE (user1_id = ? OR user2_id = ?) AND status = 'active'
        LIMIT 1
      `).bind(userId, userId).first();

      if (session) {
        const partnerId = session.user1_id === userId ? session.user2_id : session.user1_id;
        const partner = await env.DB.prepare('SELECT id, username, english_level FROM users WHERE id = ?').bind(partnerId).first();

        return Response.json({ 
          active_session: true, 
          session: { ...session, partner } 
        }, { headers: corsHeaders });
      }

      return Response.json({ active_session: false }, { headers: corsHeaders });
    }

    // End Session
    if (url.pathname === '/api/matching/end' && request.method === 'POST') {
      const { session_id } = await request.json() as any;
      await env.DB.prepare("UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?").bind(session_id).run();
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // --- SIGNALING ROUTE (WEBSOCKET) ---
    // This connects the frontend to the specific Durable Object for the session
    if (url.pathname === '/api/signal') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return new Response('Missing sessionId', { status: 400 });

      const id = env.SIGNALING.idFromName(sessionId);
      const stub = env.SIGNALING.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};