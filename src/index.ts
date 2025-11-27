/**
 * Cloudflare Worker + Durable Object for Chatter3
 * ADAPTED for existing schema (point_transactions, sessions, etc.)
 */

interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
}

const uuid = () => crypto.randomUUID();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// --- Durable Object for Signaling (Remains the same) ---
export class SignalingServer {
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
    // Simple broadcast for MVP 1-on-1
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

// --- Main Worker Logic ---
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Auth/Login
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const { email, password } = await request.json() as any;
      
      // Existing schema uses 'users' table
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      
      if (!user) {
        // Auto-register for MVP. Note: Your schema has 'english_level' etc.
        const newId = uuid();
        const now = new Date().toISOString().replace('T', ' ').split('.')[0]; // SQLite format
        
        await env.DB.prepare(`
          INSERT INTO users (id, email, username, points, created_at, english_level, password_hash) 
          VALUES (?, ?, ?, 100, ?, 'beginner', ?)
        `)
          .bind(newId, email, email.split('@')[0], now, 'placeholder_hash') // In prod: hash password
          .run();
          
        return Response.json({ 
          token: newId, id: newId, email, points: 100, username: email.split('@')[0], bio: '' 
        }, { headers: corsHeaders });
      }

      return Response.json(user, { headers: corsHeaders });
    }

    // 2. User Profile Update
    if (url.pathname === '/api/user/update' && request.method === 'POST') {
      const { id, bio, username } = await request.json() as any;
      
      // Updates 'bio' (new column) and 'username'
      await env.DB.prepare('UPDATE users SET bio = ?, username = ? WHERE id = ?')
        .bind(bio, username, id)
        .run();
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // 3. Reward Points (Call Completed)
    if (url.pathname === '/api/user/reward' && request.method === 'POST') {
      const { id, durationSeconds } = await request.json() as any;
      const pointsEarned = Math.floor(durationSeconds / 60) * 10;

      if (pointsEarned > 0) {
        const now = new Date().toISOString().replace('T', ' ').split('.')[0];
        
        // Using existing 'point_transactions' table structure
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(pointsEarned, id),
          env.DB.prepare(`
            INSERT INTO point_transactions (id, user_id, points, activity_type, created_at) 
            VALUES (?, ?, ?, 'video_call', ?)
          `).bind(uuid(), id, pointsEarned, now)
        ]);
      }
      return Response.json({ pointsEarned }, { headers: corsHeaders });
    }

    // 4. Signaling
    if (url.pathname === '/api/signal') {
      const id = env.SIGNALING.idFromName('GLOBAL_LOBBY');
      return env.SIGNALING.get(id).fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};