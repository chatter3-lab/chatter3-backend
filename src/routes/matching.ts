import { Hono } from 'hono';

export const matching = new Hono<{ Bindings: { DB: D1Database } }>();

// Join the matching queue for video call
matching.post('/join', async (c) => {
  try {
    const { user_id, english_level } = await c.req.json();

    if (!user_id || !english_level) {
      return c.json({ error: 'User ID and English level are required' }, 400);
    }

    // Remove user from queue if already there
    await c.env.DB.prepare(
      'DELETE FROM matching_queue WHERE user_id = ?'
    ).bind(user_id).run();

    // Add user to queue
    await c.env.DB.prepare(
      'INSERT INTO matching_queue (user_id, english_level) VALUES (?, ?)'
    ).bind(user_id, english_level).run();

    // Try to find a match (same English level)
    const match = await c.env.DB.prepare(
      `SELECT user_id FROM matching_queue 
       WHERE english_level = ? AND user_id != ? 
       ORDER BY joined_at LIMIT 1`
    ).bind(english_level, user_id).first();

    if (match) {
      // Create video call session
      const sessionId = crypto.randomUUID();
      const roomName = `video_room_${sessionId}`;

      await c.env.DB.prepare(
        'INSERT INTO sessions (id, user1_id, user2_id, english_level, room_name, status) VALUES (?, ?, ?, ?, ?, "active")'
      ).bind(sessionId, user_id, match.user_id, english_level, roomName).run();

      // Remove both users from queue
      await c.env.DB.prepare(
        'DELETE FROM matching_queue WHERE user_id IN (?, ?)'
      ).bind(user_id, match.user_id).run();

      // Get partner info
      const partner = await c.env.DB.prepare(
        'SELECT id, username, english_level FROM users WHERE id = ?'
      ).bind(match.user_id).first();

      return c.json({
        success: true,
        matched: true,
        session_id: sessionId,
        partner: partner,
        room_name: roomName,
        call_type: 'video',
        duration_limit: getDurationLimit(english_level)
      });
    }

    return c.json({
      success: true,
      matched: false,
      message: 'Searching for a conversation partner...',
      call_type: 'video'
    });

  } catch (error: any) {
    console.error('Join matching error:', error);
    return c.json({ error: 'Failed to join matching queue' }, 500);
  }
});

// Leave the matching queue
matching.post('/leave', async (c) => {
  try {
    const { user_id } = await c.req.json();

    await c.env.DB.prepare(
      'DELETE FROM matching_queue WHERE user_id = ?'
    ).bind(user_id).run();

    return c.json({ success: true, message: 'Left matching queue' });

  } catch (error: any) {
    console.error('Leave matching error:', error);
    return c.json({ error: 'Failed to leave matching queue' }, 500);
  }
});

// Get active video session for user
matching.get('/session/:user_id', async (c) => {
  try {
    const user_id = c.req.param('user_id');

    const session = await c.env.DB.prepare(
      `SELECT * FROM sessions 
       WHERE (user1_id = ? OR user2_id = ?) 
       AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(user_id, user_id).first();

    if (!session) {
      return c.json({ active_session: false });
    }

    // Get partner info
    const partnerId = session.user1_id === user_id ? session.user2_id : session.user1_id;
    const partner = await c.env.DB.prepare(
      'SELECT id, username, english_level FROM users WHERE id = ?'
    ).bind(partnerId).first();

    return c.json({
      active_session: true,
      session: {
        id: session.id,
        partner: partner,
        english_level: session.english_level,
        room_name: session.room_name,
        duration_limit: getDurationLimit(session.english_level),
        call_type: 'video'
      }
    });

  } catch (error: any) {
    console.error('Get session error:', error);
    return c.json({ error: 'Failed to get session' }, 500);
  }
});

// End video session and award points
matching.post('/end', async (c) => {
  try {
    const { session_id, user_id } = await c.req.json();

    const session = await c.env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).bind(session_id).first();

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // Calculate duration
    const startedAt = new Date(session.created_at);
    const endedAt = new Date();
    const duration = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

    // Update session
    await c.env.DB.prepare(
      'UPDATE sessions SET status = "completed", ended_at = CURRENT_TIMESTAMP, duration = ? WHERE id = ?'
    ).bind(duration, session_id).run();

    // Award points based on English level
    const points = calculatePoints(session.english_level, duration);
    
    // Award points to both users
    await c.env.DB.prepare(
      'UPDATE users SET points = points + ? WHERE id IN (?, ?)'
    ).bind(points, session.user1_id, session.user2_id).run();

    // Record point transaction
    const transactionId1 = crypto.randomUUID();
    const transactionId2 = crypto.randomUUID();
    
    await c.env.DB.prepare(
      'INSERT INTO point_transactions (id, user_id, points, activity_type, session_id) VALUES (?, ?, ?, "video_call", ?)'
    ).bind(transactionId1, session.user1_id, points, session_id).run();
    
    await c.env.DB.prepare(
      'INSERT INTO point_transactions (id, user_id, points, activity_type, session_id) VALUES (?, ?, ?, "video_call", ?)'
    ).bind(transactionId2, session.user2_id, points, session_id).run();

    return c.json({ 
      success: true, 
      message: 'Video call ended',
      duration: duration,
      points_earned: points
    });

  } catch (error: any) {
    console.error('End session error:', error);
    return c.json({ error: 'Failed to end session' }, 500);
  }
});

// Helper function to get duration limits
function getDurationLimit(englishLevel: string): number {
  const limits = {
    beginner: 300,     // 5 minutes
    intermediate: 600, // 10 minutes
    advanced: 600      // 10 minutes
  };
  return limits[englishLevel] || 300;
}

// Helper function to calculate points
function calculatePoints(englishLevel: string, duration: number): number {
  const basePoints = {
    beginner: 10,
    intermediate: 20,
    advanced: 20
  };
  return basePoints[englishLevel] || 10;
}

export default matching;