/**
 * Cloudflare Worker Backend for Chatter3
 * Handles: Auth, User Profile, Matching Queue, and Daily.co Integration
 */

interface Env {
  DB: D1Database;
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. AUTHENTICATION ---

    // Login (Email/Password mock for MVP)
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const { email, password } = await request.json() as any;
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      
      if (!user) {
        return Response.json({ success: false, error: 'User not found' }, { headers: corsHeaders });
      }
      // In prod: verify password_hash
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

    // Google Auth (Stub - assumes client sends valid info for MVP)
    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
        // In prod: Verify credential with Google
        // For MVP: We assume success and upsert user
        return Response.json({ success: true, user: { id: uuid(), username: 'Google User', points: 100 } }, { headers: corsHeaders });
    }

    // --- 2. MATCHING LOGIC ---

    // Join Matching Queue
    if (url.pathname === '/api/matching/join' && request.method === 'POST') {
      const { user_id, english_level } = await request.json() as any;

      // 1. Check if anyone else is waiting with same level
      const match = await env.DB.prepare(`
        SELECT * FROM matching_queue 
        WHERE english_level = ? AND user_id != ? 
        ORDER BY joined_at ASC LIMIT 1
      `).bind(english_level, user_id).first();

      if (match) {
        // MATCH FOUND!
        const sessionId = uuid();
        const partnerId = match.user_id as string;
        
        // Create session
        await env.DB.prepare(`
          INSERT INTO sessions (id, user1_id, user2_id, english_level, status, created_at)
          VALUES (?, ?, ?, ?, 'active', datetime('now'))
        `).bind(sessionId, user_id, partnerId, english_level).run();

        // Remove partner from queue
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(partnerId).run();

        return Response.json({ success: true, matched: true, session_id: sessionId }, { headers: corsHeaders });
      } else {
        // NO MATCH -> Add to queue
        // Remove existing queue entry for this user first to be safe
        await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();
        
        await env.DB.prepare(`
          INSERT INTO matching_queue (user_id, english_level, joined_at)
          VALUES (?, ?, datetime('now'))
        `).bind(user_id, english_level).run();

        return Response.json({ success: true, matched: false }, { headers: corsHeaders });
      }
    }

    // Poll for Session Status
    if (url.pathname.startsWith('/api/matching/session/')) {
      const userId = url.pathname.split('/').pop();
      
      // Find active session where user is either user1 or user2
      const session: any = await env.DB.prepare(`
        SELECT * FROM sessions 
        WHERE (user1_id = ? OR user2_id = ?) AND status = 'active'
        LIMIT 1
      `).bind(userId, userId).first();

      if (session) {
        // Get partner details
        const partnerId = session.user1_id === userId ? session.user2_id : session.user1_id;
        const partner = await env.DB.prepare('SELECT id, username, english_level FROM users WHERE id = ?').bind(partnerId).first();

        return Response.json({ 
          active_session: true, 
          session: { ...session, partner, room_name: session.room_name || 'waiting_room' } 
        }, { headers: corsHeaders });
      }

      return Response.json({ active_session: false }, { headers: corsHeaders });
    }

    // Leave Matching Queue
    if (url.pathname === '/api/matching/leave' && request.method === 'POST') {
      const { user_id } = await request.json() as any;
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id = ?').bind(user_id).run();
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // --- 3. DAILY.CO INTEGRATION ---

    if (url.pathname === '/api/daily/create-room' && request.method === 'POST') {
      const { session_id } = await request.json() as any;
      
      // 1. Check if room already exists for this session
      const existing = await env.DB.prepare('SELECT room_name FROM sessions WHERE id = ?').bind(session_id).first();
      if (existing && existing.room_name && existing.room_name.startsWith('https')) {
         return Response.json({ success: true, room: { url: existing.room_name } }, { headers: corsHeaders });
      }

      // 2. Create Room on Daily.co
      const dailyRes = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DAILY_API_KEY}`
        },
        body: JSON.stringify({
          properties: {
            exp: Math.floor(Date.now() / 1000) + 900 // Expires in 15 mins
          }
        })
      });

      const dailyData: any = await dailyRes.json();

      if (dailyData.url) {
        // Save URL to session
        await env.DB.prepare('UPDATE sessions SET room_name = ? WHERE id = ?')
          .bind(dailyData.url, session_id).run();
        
        return Response.json({ success: true, room: { url: dailyData.url } }, { headers: corsHeaders });
      }

      return Response.json({ success: false, error: 'Failed to create Daily room' }, { headers: corsHeaders });
    }

    // End Session & Award Points
    if (url.pathname === '/api/matching/end' && request.method === 'POST') {
      const { session_id, user_id } = await request.json() as any;
      
      // Mark completed
      await env.DB.prepare("UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?")
        .bind(session_id).run();
        
      // Award Points (Mock: 50 pts for completing)
      await env.DB.prepare("UPDATE users SET points = points + 50 WHERE id = ?").bind(user_id).run();
      
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};