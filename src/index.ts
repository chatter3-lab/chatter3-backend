/**
 * Cloudflare Worker Backend for Chatter3
 * Includes: Durable Object (SignalingServer) + API Logic
 */

interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
  DAILY_API_KEY: string;
}

// Helper: Standard CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Helper: UUID Generator
const uuid = () => crypto.randomUUID();

// --- 1. DURABLE OBJECT CLASS (REQUIRED FOR WRANGLER DEPLOY) ---
export class SignalingServer implements DurableObject {
  state: DurableObjectState;
  sessions: Map<WebSocket, any>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request: Request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.state.acceptWebSocket(server);
    this.sessions.set(server, { id: uuid() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    // Simple broadcast for signaling
    for (const [otherWs, session] of this.sessions) {
      if (otherWs !== ws) {
        try { otherWs.send(message); } catch (e) { this.sessions.delete(otherWs); }
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }
}

// --- 2. MAIN WORKER LOGIC ---
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- AUTHENTICATION ---

    // Login (Email/Password)
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const { email, password } = await request.json() as any;
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      
      if (!user) {
        return Response.json({ success: false, error: 'User not found' }, { headers: corsHeaders });
      }
      return Response.json({ success: true, user }, { headers: corsHeaders });
    }

    // Register
    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      const { email, username, password, english_level } = await request.json() as any;
      const newId = uuid();
      
      try {
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, english_level, points, created_at)
          VALUES (?, ?, ?, ?, ?, 100, datetime('now'))
        `).bind(newId, username, email, 'hashed_' + password, english_level).run();
        
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(newId).first();
        return Response.json({ success: true, user }, { headers: corsHeaders });
      } catch (e: any) {
        return Response.json({ success: false, error: 'Email or Username already exists' }, { headers: corsHeaders });
      }
    }

    // Google Auth Logic (Upsert: Login if exists, Register if not)
    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      const { credential } = await request.json() as any;
      
      // DECODE TOKEN: In production, verify this token with Google's public keys!
      // For this MVP step, we decode the payload to get the email.
      // (Assuming standard JWT format: header.payload.signature)
      try {
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
        return Response.json({ success: false, error: 'Invalid Token' }, { headers: corsHeaders });
      }
    }

    // --- MATCHING LOGIC ---

    // Join Queue
    if (url.pathname === '/api/matching/join' && request.method === 'POST') {
      const { user_id, english_level } = await request.json() as any;

      const match = await env.DB.prepare(`
        SELECT * FROM matching_queue 
        WHERE english_level = ? AND user_id != ? 
        ORDER BY joined_at ASC LIMIT 1
      `).bind(english_level, user_id).first();

      if (match) {
        const sessionId = uuid();
        const partnerId = match.user_id as string;
        
        await env.DB.prepare(`
          INSERT INTO sessions (id, user1_id, user2_id, english_level, status, created_at)
          VALUES (?, ?, ?, ?, 'active', datetime('now'))
        `).bind(sessionId, user_id, partnerId, english_level).run();

        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(partnerId).run();

        return Response.json({ success: true, matched: true, session_id: sessionId }, { headers: corsHeaders });
      } else {
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();
        await env.DB.prepare(`
          INSERT INTO matching_queue (user_id, english_level, joined_at)
          VALUES (?, ?, datetime('now'))
        `).bind(user_id, english_level).run();

        return Response.json({ success: true, matched: false }, { headers: corsHeaders });
      }
    }

    // Poll Session
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
          session: { ...session, partner, room_name: session.room_name } 
        }, { headers: corsHeaders });
      }

      return Response.json({ active_session: false }, { headers: corsHeaders });
    }

    // --- DAILY.CO & SIGNALING ---

    if (url.pathname === '/api/daily/create-room' && request.method === 'POST') {
      const { session_id } = await request.json() as any;
      
      const existing = await env.DB.prepare('SELECT room_name FROM sessions WHERE id = ?').bind(session_id).first();
      if (existing && existing.room_name && existing.room_name.startsWith('https')) {
         return Response.json({ success: true, room: { url: existing.room_name } }, { headers: corsHeaders });
      }

      const dailyRes = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DAILY_API_KEY}`
        },
        body: JSON.stringify({ properties: { exp: Math.floor(Date.now() / 1000) + 900 } })
      });

      const dailyData: any = await dailyRes.json();

      if (dailyData.url) {
        await env.DB.prepare('UPDATE sessions SET room_name = ? WHERE id = ?').bind(dailyData.url, session_id).run();
        return Response.json({ success: true, room: { url: dailyData.url } }, { headers: corsHeaders });
      }
      return Response.json({ success: false, error: 'Failed to create Daily room' }, { headers: corsHeaders });
    }

    if (url.pathname === '/api/matching/end' && request.method === 'POST') {
      const { session_id, user_id } = await request.json() as any;
      await env.DB.prepare("UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?").bind(session_id).run();
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // Signaling Route
    if (url.pathname === '/api/signal') {
      const id = env.SIGNALING.idFromName('GLOBAL_LOBBY');
      return env.SIGNALING.get(id).fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};