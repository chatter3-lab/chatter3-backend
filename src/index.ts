/**
 * Chatter3 Backend — Cloudflare Worker
 * Point system: FP (daily consumable) + RP (permanent reward)
 */

interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
  RESEND_API_KEY: string;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (data: any, status = 200) =>
  Response.json(data, { status, headers: cors });
const uuid = () => crypto.randomUUID();

// ─── CONSTANTS ──────────────────────────────────────────────
const DAILY_FP = 1;           // FP granted per day
const CALL_FP_COST = 1;       // FP consumed per call
const RP_PER_COMPLETION = 1;  // RP for completing a call (both rated)
const RP_PER_GOOD = 0.5;      // RP bonus for receiving a "good" rating
const RP_TO_FP_RATE = 3;      // 3 RP → 1 FP
const ADMIN_EMAILS = ['dax@chatter3.com', 'john@chatter3.com'];
const REPORT_EMAIL = 'report@chatter3.com';
const FROM_EMAIL = 'noreply@chatter3.com';
const RESEND_API_KEY = '1f1d4a0f-f54b-4230-af7a-e6db6b53660c';

// ─── HELPERS ────────────────────────────────────────────────
const todayUTC = () => new Date().toISOString().slice(0, 10);

async function ensureDailyFP(db: D1Database, userId: string): Promise<void> {
  const user: any = await db.prepare(
    'SELECT fp_balance, fp_last_reset FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!user) return;
  const today = todayUTC();
  if (user.fp_last_reset !== today) {
    await db.prepare(
      'UPDATE users SET fp_balance = ?, fp_last_reset = ? WHERE id = ?'
    ).bind(DAILY_FP, today, userId).run();
  }
}

async function sendEmail(resendKey: string, to: string, subject: string, html: string) {
  if (!resendKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  }).catch(() => {});
}

async function requireAdmin(db: D1Database, adminId: string): Promise<boolean> {
  const u: any = await db.prepare(
    'SELECT is_admin FROM users WHERE id = ? AND is_admin = 1'
  ).bind(adminId).first();
  return !!u;
}

// ─── SIGNALING DURABLE OBJECT ───────────────────────────────
export class SignalingServer implements DurableObject {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  constructor(state: DurableObjectState) { this.state = state; this.sessions = new Set(); }

  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('Expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this.sessions.add(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string) {
    for (const other of this.sessions) {
      if (other !== ws) { try { other.send(message); } catch { this.sessions.delete(other); } }
    }
  }
  async webSocketClose(ws: WebSocket) { this.sessions.delete(ws); }
}

// ─── MAIN WORKER ────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── ICE SERVERS ──────────────────────────────────────────
    if (path === '/api/ice-servers') {
      try {
        const r = await fetch('https://chatter3.metered.live/api/v1/turn/credentials?apiKey=075477e7cb4cd90b70eb8fa70dbb4b7ab76a');
        const iceServers = await r.json();
        return json({ iceServers });
      } catch {
        return json({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      }
    }

    // ── ONLINE STATS ─────────────────────────────────────────
    if (path === '/api/stats/online') {
      const queue: any = await env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue').first();
      const sessions: any = await env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'").first();
      const byLevel: any = await env.DB.prepare(
        'SELECT english_level, COUNT(*) as c FROM matching_queue GROUP BY english_level'
      ).all();
      const by_level: Record<string, number> = {};
      for (const r of (byLevel.results || [])) by_level[(r as any).english_level] = (r as any).c;
      const searching = queue?.c || 0;
      const in_call = (sessions?.c || 0) * 2;
      return json({ searching, in_call, total: searching + in_call, by_level });
    }

    // ── AUTH: GOOGLE ──────────────────────────────────────────
    if (path === '/api/auth/google' && request.method === 'POST') {
      const { credential } = await request.json() as any;
      try {
        const parts = credential.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const email = payload.email;
        const name = payload.name || email.split('@')[0];
        const picture = payload.picture || '';
        const isAdmin = ADMIN_EMAILS.includes(email) ? 1 : 0;

        let user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!user) {
          const id = uuid();
          await env.DB.prepare(`
            INSERT INTO users (id, username, email, password_hash, english_level, points,
              fp_balance, fp_last_reset, rp_balance, is_admin, created_at, avatar_url, nickname)
            VALUES (?, ?, ?, 'google_oauth_user', 'beginner', 0, ?, ?, 0, ?, datetime('now'), ?, ?)
          `).bind(id, name, email, DAILY_FP, todayUTC(), isAdmin, picture, name).run();
          user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
        } else {
          // Ensure admin flag is set for known admins
          if (isAdmin && !user.is_admin) {
            await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
          }
          await ensureDailyFP(env.DB, user.id);
          user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
        }
        return json({ success: true, user });
      } catch (e: any) {
        return json({ success: false, error: 'Invalid token' });
      }
    }

    // ── AUTH: REGISTER ────────────────────────────────────────
    if (path === '/api/auth/register' && request.method === 'POST') {
      const { email, username, english_level, country, native_language } = await request.json() as any;
      const id = uuid();
      try {
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, english_level, points,
            fp_balance, fp_last_reset, rp_balance, country, native_language, created_at)
          VALUES (?, ?, ?, 'email_user', ?, 0, ?, ?, 0, ?, ?, datetime('now'))
        `).bind(id, username, email, english_level || 'beginner',
          DAILY_FP, todayUTC(), country || '', native_language || '').run();
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
        return json({ success: true, user });
      } catch {
        return json({ success: false, error: 'User already exists' });
      }
    }

    // ── AUTH: LOGIN ───────────────────────────────────────────
    if (path === '/api/auth/login' && request.method === 'POST') {
      const { email } = await request.json() as any;
      const user: any = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (!user) return json({ success: false, error: 'User not found' });
      if (user.is_banned) return json({ success: false, error: 'Account suspended. Contact support.' });
      await ensureDailyFP(env.DB, user.id);
      const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
      return json({ success: true, user: fresh });
    }

    // ── USER: GET ─────────────────────────────────────────────
    if (path.startsWith('/api/user/') && !path.includes('/daily') && !path.includes('/exchange')
        && !path.includes('/update') && !path.includes('/history') && !path.includes('/balances')
        && request.method === 'GET') {
      const userId = path.split('/').pop();
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
      return json({ success: true, user });
    }

    // ── USER: UPDATE ──────────────────────────────────────────
    if (path === '/api/user/update' && request.method === 'POST') {
      const { id, nickname, country, native_language, english_level, bio, avatar_url } = await request.json() as any;
      await env.DB.prepare(`
        UPDATE users SET nickname=?, country=?, native_language=?, english_level=?, bio=?, avatar_url=?
        WHERE id=?
      `).bind(nickname, country, native_language, english_level, bio, avatar_url, id).run();
      const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      return json({ success: true, user });
    }

    // ── USER: BALANCES ────────────────────────────────────────
    if (path.startsWith('/api/user/balances/')) {
      const userId = path.split('/').pop();
      await ensureDailyFP(env.DB, userId as string);
      const user: any = await env.DB.prepare(
        'SELECT fp_balance, rp_balance, points FROM users WHERE id = ?'
      ).bind(userId).first();
      return json({ success: true, fp: user?.fp_balance ?? 0, rp: user?.rp_balance ?? 0 });
    }

    // ── USER: EXCHANGE RP → FP ────────────────────────────────
    if (path === '/api/user/exchange-rp' && request.method === 'POST') {
      const { user_id, quantity } = await request.json() as any;
      const qty = Math.max(1, parseInt(quantity) || 1);
      const cost = qty * RP_TO_FP_RATE;
      await ensureDailyFP(env.DB, user_id);
      const user: any = await env.DB.prepare(
        'SELECT fp_balance, rp_balance FROM users WHERE id = ?'
      ).bind(user_id).first();
      if (!user) return json({ success: false, error: 'User not found' });
      if (user.rp_balance < cost)
        return json({ success: false, error: `Need ${cost} RP (you have ${user.rp_balance})` });
      await env.DB.prepare(
        'UPDATE users SET rp_balance = rp_balance - ?, fp_balance = fp_balance + ? WHERE id = ?'
      ).bind(cost, qty, user_id).run();
      const fresh: any = await env.DB.prepare(
        'SELECT fp_balance, rp_balance FROM users WHERE id = ?'
      ).bind(user_id).first();
      return json({ success: true, fp: fresh.fp_balance, rp: fresh.rp_balance });
    }

    // ── USER: HISTORY ─────────────────────────────────────────
    if (path === '/api/user/history' && request.method === 'POST') {
      const { user_id } = await request.json() as any;
      const history = await env.DB.prepare(`
        SELECT s.id, s.created_at, s.ended_at, s.duration,
          CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner_name,
          CASE WHEN s.user1_id=? THEN u2.avatar_url ELSE u1.avatar_url END as partner_avatar,
          pt.points as points_earned
        FROM sessions s
        JOIN users u1 ON s.user1_id=u1.id
        JOIN users u2 ON s.user2_id=u2.id
        LEFT JOIN point_transactions pt
          ON pt.session_id=s.id AND pt.user_id=? AND pt.activity_type='video_call_reward'
        WHERE (s.user1_id=? OR s.user2_id=?) AND s.status='completed'
        ORDER BY s.created_at DESC LIMIT 20
      `).bind(user_id, user_id, user_id, user_id, user_id).all();
      return json({ success: true, history: history.results });
    }

    // ── MATCHING: JOIN ────────────────────────────────────────
    if (path === '/api/matching/join' && request.method === 'POST') {
      const { user_id, english_level, country, native_language } = await request.json() as any;

      // Ensure daily FP reset then check balance
      await ensureDailyFP(env.DB, user_id);
      const caller: any = await env.DB.prepare(
        'SELECT fp_balance, country, native_language, is_banned FROM users WHERE id = ?'
      ).bind(user_id).first();
      if (!caller) return json({ success: false, error: 'User not found' });
      if (caller.is_banned) return json({ success: false, error: 'Account suspended' });
      if ((caller.fp_balance || 0) < CALL_FP_COST)
        return json({ success: false, error: 'insufficient_fp', fp: caller.fp_balance });

      const callerCountry = (caller.country || country || '').trim().toLowerCase();
      const callerLang = (caller.native_language || native_language || '').trim().toLowerCase();

      try { await env.DB.prepare("DELETE FROM matching_queue WHERE joined_at < datetime('now','-15 seconds')").run(); } catch {}

      // Strict: different country + language + not blocked
      const strictMatch: any = await env.DB.prepare(`
        SELECT mq.user_id FROM matching_queue mq
        JOIN users u ON mq.user_id=u.id
        WHERE mq.english_level=? AND mq.user_id!=? AND u.is_banned=0
          AND (?='' OR LOWER(COALESCE(u.country,''))!=?)
          AND (?='' OR LOWER(COALESCE(u.native_language,''))!=?)
          AND mq.user_id NOT IN (
            SELECT blocked_id FROM user_blocks WHERE blocker_id=?
            UNION SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
        ORDER BY mq.joined_at ASC LIMIT 1
      `).bind(english_level, user_id, callerCountry, callerCountry,
        callerLang, callerLang, user_id, user_id).first();

      // Fallback: any non-banned, non-blocked user at same level
      const match: any = strictMatch || await env.DB.prepare(`
        SELECT mq.user_id FROM matching_queue mq
        JOIN users u ON mq.user_id=u.id
        WHERE mq.english_level=? AND mq.user_id!=? AND u.is_banned=0
          AND mq.user_id NOT IN (
            SELECT blocked_id FROM user_blocks WHERE blocker_id=?
            UNION SELECT blocker_id FROM user_blocks WHERE blocked_id=?)
        ORDER BY mq.joined_at ASC LIMIT 1
      `).bind(english_level, user_id, user_id, user_id).first();

      if (match) {
        const sessionId = uuid();
        const partnerId = match.user_id as string;
        // Deduct 1 FP from both users
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(user_id),
          env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(partnerId),
          env.DB.prepare(`INSERT INTO sessions (id,user1_id,user2_id,english_level,status,created_at)
            VALUES (?,?,?,?,'active',datetime('now'))`).bind(sessionId, user_id, partnerId, english_level),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(partnerId),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id),
        ]);
        return json({ success: true, matched: true, session_id: sessionId });
      } else {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO matching_queue (user_id,english_level,joined_at)
          VALUES (?,?,datetime('now'))
        `).bind(user_id, english_level).run();
        return json({ success: true, matched: false });
      }
    }

    // ── MATCHING: LEAVE ───────────────────────────────────────
    if (path === '/api/matching/leave' && request.method === 'POST') {
      const { user_id } = await request.json() as any;
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id).run();
      return json({ success: true });
    }

    // ── MATCHING: SESSION ─────────────────────────────────────
    if (path.startsWith('/api/matching/session/')) {
      const userId = path.split('/').pop();
      const session: any = await env.DB.prepare(`
        SELECT * FROM sessions WHERE (user1_id=? OR user2_id=?) AND status='active' LIMIT 1
      `).bind(userId, userId).first();
      if (!session) return json({ active_session: false });
      const partnerId = session.user1_id === userId ? session.user2_id : session.user1_id;
      const partner = await env.DB.prepare(
        'SELECT id,username,nickname,english_level,avatar_url,country,native_language FROM users WHERE id=?'
      ).bind(partnerId).first();
      return json({ active_session: true, session: { ...session, partner } });
    }

    // ── MATCHING: END ─────────────────────────────────────────
    if (path === '/api/matching/end' && request.method === 'POST') {
      const { session_id, user_id, reason } = await request.json() as any;
      const session: any = await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if (session && session.status === 'active') {
        const duration = Math.floor((Date.now() - new Date(session.created_at).getTime()) / 1000);
        await env.DB.prepare(`
          UPDATE sessions SET status='completed', ended_at=datetime('now'), duration=? WHERE id=?
        `).bind(duration, session_id).run();
      }
      return json({ success: true });
    }

    // ── MATCHING: RATE ────────────────────────────────────────
    // Awards RP: +1 to both when both rate, +0.5 to user who RECEIVED "good"
    if (path === '/api/matching/rate' && request.method === 'POST') {
      const { session_id, user_id, rating } = await request.json() as any;
      const session: any = await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if (!session) return json({ success: false, error: 'Session not found' });

      const isUser1 = session.user1_id === user_id;
      const ratingField = isUser1 ? 'user1_rating' : 'user2_rating';
      const duration = Math.floor((Date.now() - new Date(session.created_at).getTime()) / 1000);

      await env.DB.prepare(`
        UPDATE sessions SET ${ratingField}=?, status='completed', duration=COALESCE(duration,?)
        WHERE id=?
      `).bind(rating, duration, session_id).run();

      const updated: any = await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();

      // Both have rated → award RP
      if (updated.user1_rating && updated.user2_rating) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const u1 = updated.user1_id;
        const u2 = updated.user2_id;
        const u1GoodBonus = updated.user2_rating === 'good' ? RP_PER_GOOD : 0; // u1 RECEIVED good from u2
        const u2GoodBonus = updated.user1_rating === 'good' ? RP_PER_GOOD : 0; // u2 RECEIVED good from u1
        const u1RP = RP_PER_COMPLETION + u1GoodBonus;
        const u2RP = RP_PER_COMPLETION + u2GoodBonus;

        await env.DB.batch([
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u1RP, u1),
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u2RP, u2),
          env.DB.prepare(`INSERT INTO point_transactions (id,user_id,points,activity_type,session_id,created_at)
            VALUES (?,?,?,'video_call_reward',?,?)`).bind(uuid(), u1, u1RP, session_id, now),
          env.DB.prepare(`INSERT INTO point_transactions (id,user_id,points,activity_type,session_id,created_at)
            VALUES (?,?,?,'video_call_reward',?,?)`).bind(uuid(), u2, u2RP, session_id, now),
        ]);

        const myRP = isUser1 ? u1RP : u2RP;
        return json({ success: true, rp_awarded: myRP });
      }
      return json({ success: true, message: 'Rating saved. Waiting for partner.' });
    }

    // ── REPORT ────────────────────────────────────────────────
    if (path === '/api/report' && request.method === 'POST') {
      const { reporter_id, reported_id, session_id, reason } = await request.json() as any;
      if (!reporter_id || !reported_id) return json({ success: false, error: 'Missing fields' });
      const id = uuid();
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      await env.DB.prepare(`
        INSERT INTO user_reports (id,reporter_id,reported_id,session_id,reason,created_at)
        VALUES (?,?,?,?,?,?)
      `).bind(id, reporter_id, reported_id, session_id || null, reason || '', now).run();

      // Fetch names for email
      const reporter: any = await env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reporter_id).first();
      const reported: any = await env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reported_id).first();

      await sendEmail(
        env.RESEND_API_KEY,
        REPORT_EMAIL,
        `[Chatter3] New User Report — ${reason}`,
        `<h2>New Report Submitted</h2>
        <p><strong>Reporter:</strong> ${reporter?.username} (${reporter?.email})</p>
        <p><strong>Reported:</strong> ${reported?.username} (${reported?.email})</p>
        <p><strong>Session ID:</strong> ${session_id || 'N/A'}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Time:</strong> ${now} UTC</p>
        <hr/>
        <p><a href="https://app.chatter3.com/admin">View in Admin Dashboard</a></p>`
      );
      return json({ success: true });
    }

    // ── BLOCK ─────────────────────────────────────────────────
    if (path === '/api/block' && request.method === 'POST') {
      const { blocker_id, blocked_id } = await request.json() as any;
      if (!blocker_id || !blocked_id) return json({ success: false, error: 'Missing fields' });
      const id = uuid();
      await env.DB.prepare(`
        INSERT OR IGNORE INTO user_blocks (id,blocker_id,blocked_id,created_at)
        VALUES (?,?,?,datetime('now'))
      `).bind(id, blocker_id, blocked_id).run();
      return json({ success: true });
    }

    // ── ADMIN: AUTH CHECK ─────────────────────────────────────
    if (path === '/api/admin/check' && request.method === 'POST') {
      const { user_id } = await request.json() as any;
      const ok = await requireAdmin(env.DB, user_id);
      return json({ is_admin: ok });
    }

    // ── ADMIN: STATS ──────────────────────────────────────────
    if (path === '/api/admin/stats' && request.method === 'POST') {
      const { admin_id } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);

      const today = todayUTC();
      const monthStart = today.slice(0, 7) + '-01';
      const [totalUsers, dau, mau, totalSessions, activeSessions, queue, pendingReports, newUsersToday]: any[] =
        await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
          env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at >= ?").bind(today).first(),
          env.DB.prepare("SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at >= ?").bind(monthStart).first(),
          env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='completed'").first(),
          env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'").first(),
          env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue').first(),
          env.DB.prepare("SELECT COUNT(*) as c FROM user_reports WHERE status='pending'").first(),
          env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= ?").bind(today).first(),
        ]);

      const sessionsByDay = await env.DB.prepare(`
        SELECT DATE(created_at) as day, COUNT(*) as c
        FROM sessions WHERE created_at >= DATE('now','-30 days')
        GROUP BY day ORDER BY day DESC LIMIT 30
      `).all();

      return json({
        total_users: totalUsers?.c || 0,
        dau: dau?.c || 0,
        mau: mau?.c || 0,
        total_sessions: totalSessions?.c || 0,
        active_sessions: activeSessions?.c || 0,
        queue_size: queue?.c || 0,
        pending_reports: pendingReports?.c || 0,
        new_users_today: newUsersToday?.c || 0,
        sessions_by_day: sessionsByDay.results || [],
      });
    }

    // ── ADMIN: USER SEARCH ────────────────────────────────────
    if (path === '/api/admin/users' && request.method === 'POST') {
      const { admin_id, query } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      const q = `%${query || ''}%`;
      const users = await env.DB.prepare(`
        SELECT id, username, nickname, email, english_level, fp_balance, rp_balance,
               is_admin, is_banned, ban_reason, country, native_language, created_at
        FROM users WHERE username LIKE ? OR email LIKE ? OR nickname LIKE ?
        ORDER BY created_at DESC LIMIT 50
      `).bind(q, q, q).all();
      return json({ success: true, users: users.results });
    }

    // ── ADMIN: USER DETAIL ────────────────────────────────────
    if (path.startsWith('/api/admin/user/') && !path.endsWith('/adjust') && !path.endsWith('/ban')
        && !path.endsWith('/unban') && request.method === 'POST') {
      const userId = path.split('/')[4];
      const { admin_id } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
      const sessions = await env.DB.prepare(`
        SELECT s.id, s.created_at, s.duration, s.status, s.user1_rating, s.user2_rating,
          CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner
        FROM sessions s
        JOIN users u1 ON s.user1_id=u1.id
        JOIN users u2 ON s.user2_id=u2.id
        WHERE s.user1_id=? OR s.user2_id=?
        ORDER BY s.created_at DESC LIMIT 20
      `).bind(userId, userId, userId).all();
      const reports_made = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM user_reports WHERE reporter_id=?'
      ).bind(userId).first();
      const reports_received = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM user_reports WHERE reported_id=?'
      ).bind(userId).first();
      return json({ success: true, user, sessions: sessions.results, reports_made: (reports_made as any)?.c || 0, reports_received: (reports_received as any)?.c || 0 });
    }

    // ── ADMIN: ADJUST FP/RP ───────────────────────────────────
    if (path.endsWith('/adjust') && request.method === 'POST') {
      const userId = path.split('/')[4];
      const { admin_id, fp_delta, rp_delta, note } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      if (fp_delta) await env.DB.prepare('UPDATE users SET fp_balance=MAX(0,fp_balance+?) WHERE id=?').bind(fp_delta, userId).run();
      if (rp_delta) await env.DB.prepare('UPDATE users SET rp_balance=MAX(0,rp_balance+?) WHERE id=?').bind(rp_delta, userId).run();
      const user = await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(userId).first();
      return json({ success: true, user });
    }

    // ── ADMIN: BAN ────────────────────────────────────────────
    if (path.endsWith('/ban') && request.method === 'POST') {
      const userId = path.split('/')[4];
      const { admin_id, reason } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      await env.DB.prepare('UPDATE users SET is_banned=1, ban_reason=? WHERE id=?').bind(reason || 'Policy violation', userId).run();
      return json({ success: true });
    }

    // ── ADMIN: UNBAN ──────────────────────────────────────────
    if (path.endsWith('/unban') && request.method === 'POST') {
      const userId = path.split('/')[4];
      const { admin_id } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      await env.DB.prepare('UPDATE users SET is_banned=0, ban_reason=? WHERE id=?').bind('', userId).run();
      return json({ success: true });
    }

    // ── ADMIN: REPORTS LIST ───────────────────────────────────
    if (path === '/api/admin/reports' && request.method === 'POST') {
      const { admin_id, status } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      const filter = status || 'pending';
      const reports = await env.DB.prepare(`
        SELECT r.*, u1.username as reporter_name, u2.username as reported_name, u2.email as reported_email
        FROM user_reports r
        JOIN users u1 ON r.reporter_id=u1.id
        JOIN users u2 ON r.reported_id=u2.id
        WHERE r.status=?
        ORDER BY r.created_at DESC LIMIT 100
      `).bind(filter).all();
      return json({ success: true, reports: reports.results });
    }

    // ── ADMIN: ACTION REPORT ──────────────────────────────────
    if (path.startsWith('/api/admin/report/') && path.endsWith('/action') && request.method === 'POST') {
      const reportId = path.split('/')[4];
      const { admin_id, action, note } = await request.json() as any;
      if (!await requireAdmin(env.DB, admin_id)) return json({ error: 'Unauthorized' }, 403);
      const newStatus = action === 'dismiss' ? 'reviewed' : 'actioned';
      await env.DB.prepare('UPDATE user_reports SET status=?, admin_note=? WHERE id=?').bind(newStatus, note || '', reportId).run();
      return json({ success: true });
    }

    // ── SIGNAL ────────────────────────────────────────────────
    if (path === '/api/signal') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return new Response('Missing sessionId', { status: 400 });
      const id = env.SIGNALING.idFromName(sessionId);
      return env.SIGNALING.get(id).fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
