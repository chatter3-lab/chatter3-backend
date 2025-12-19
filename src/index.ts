/**
 * Cloudflare Worker Backend for Chatter3
 * Features: Auth, Matching Queue (Auto-Cleaning), Native WebRTC Signaling, Points System (Conditional)
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- NEW: ICE SERVERS ENDPOINT ---
    if (url.pathname === '/api/ice-servers') {
      try {
        // Fetch TURN credentials from Metered.ca
        const response = await fetch("https://chatter3.metered.live/api/v1/turn/credentials?apiKey=075477e7cb4cd90b70eb8fa70dbb4b7ab76a");
        const iceServers = await response.json();
        return Response.json({ iceServers }, { headers: corsHeaders });
      } catch (error) {
        // Fallback to public STUN servers if Metered API fails
        const iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ];
        return Response.json({ iceServers }, { headers: corsHeaders });
      }
    }

    // --- AUTH ROUTES ---
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const { email } = await request.json() as any;
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      
      if (!user) {
        return Response.json({ success: false, error: 'User not found' }, { headers: corsHeaders });
      }
      return Response.json({ success: true, user }, { headers: corsHeaders });
    }

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

    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      const { credential } = await request.json() as any;
      try {
        const parts = credential.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const email = payload.email;
        const name = payload.name || email.split('@')[0];

        let user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

        if (!user) {
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

    if (url.pathname.startsWith('/api/user/') && request.method === 'GET') {
      const userId = url.pathname.split('/').pop();
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
      return Response.json({ success: true, user }, { headers: corsHeaders });
    }

    // --- MATCHING ROUTES ---

    if (url.pathname === '/api/matching/join' && request.method === 'POST') {
      const { user_id, english_level } = await request.json() as any;

      try {
        await env.DB.prepare("DELETE FROM matching_queue WHERE joined_at < datetime('now', '-12 seconds')").run();
      } catch (e) { }

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
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();

        return Response.json({ success: true, matched: true, session_id: sessionId }, { headers: corsHeaders });
      } else {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO matching_queue (user_id, english_level, joined_at)
          VALUES (?, ?, datetime('now'))
        `).bind(user_id, english_level).run();

        return Response.json({ success: true, matched: false }, { headers: corsHeaders });
      }
    }

    if (url.pathname === '/api/matching/leave' && request.method === 'POST') {
      const { user_id } = await request.json() as any;
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();
      return Response.json({ success: true }, { headers: corsHeaders });
    }

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
        return Response.json({ active_session: true, session: { ...session, partner } }, { headers: corsHeaders });
      }
      return Response.json({ active_session: false }, { headers: corsHeaders });
    }

    // END Session & Award Points (Conditional)
    if (url.pathname === '/api/matching/end' && request.method === 'POST') {
      const { session_id, user_id, reason } = await request.json() as any;
      const session: any = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(session_id).first();
      
      if (session && session.status === 'active') {
        const now = new Date().toISOString().replace('T', ' ').split('.')[0];

        // Only award points if reason is 'call_completed'
        if (reason === 'call_completed') {
           const POINTS_REWARD = 10;
           await env.DB.prepare("UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?").bind(session_id).run();

           await env.DB.batch([
             env.DB.prepare("UPDATE users SET points = points + ? WHERE id = ?").bind(POINTS_REWARD, session.user1_id),
             env.DB.prepare("INSERT INTO point_transactions (id, user_id, points, activity_type, session_id, created_at) VALUES (?, ?, ?, 'video_call', ?, ?)").bind(uuid(), session.user1_id, POINTS_REWARD, session_id, now),
             env.DB.prepare("UPDATE users SET points = points + ? WHERE id = ?").bind(POINTS_REWARD, session.user2_id),
             env.DB.prepare("INSERT INTO point_transactions (id, user_id, points, activity_type, session_id, created_at) VALUES (?, ?, ?, 'video_call', ?, ?)").bind(uuid(), session.user2_id, POINTS_REWARD, session_id, now)
           ]);
           
           return Response.json({ success: true, points_awarded: POINTS_REWARD }, { headers: corsHeaders });
        } else {
           // Cancelled or Failed
           await env.DB.prepare("UPDATE sessions SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?").bind(session_id).run();
           return Response.json({ success: true, points_awarded: 0, message: "Session cancelled or failed" }, { headers: corsHeaders });
        }
      }
      return Response.json({ success: true, message: "Session already ended" }, { headers: corsHeaders });
    }

    if (url.pathname === '/api/signal') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return new Response('Missing sessionId', { status: 400 });
      const id = env.SIGNALING.idFromName(sessionId);
      return env.SIGNALING.get(id).fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};