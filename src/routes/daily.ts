import { Hono } from 'hono';

export const daily = new Hono<{ Bindings: { DB: D1Database; DAILY_API_KEY: string } }>();

// Create a Daily.co room for video call
daily.post('/create-room', async (c) => {
  try {
    const { session_id, user_id } = await c.req.json();

    if (!session_id) {
      return c.json({ error: 'Session ID is required' }, 400);
    }

    // Create room name from session ID
    const roomName = `chatter3-${session_id}-${Date.now()}`;

    // Create room in Daily.co
    const response = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.DAILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: roomName,
        privacy: 'public',
        properties: {
          max_participants: 2,
          enable_chat: false,
          enable_knocking: false,
          start_video_off: false,
          start_audio_off: false,
          exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiry
        }
      }),
    });

    const roomData = await response.json();

    if (!response.ok) {
      throw new Error(roomData.error || 'Failed to create room');
    }

    // Generate meeting token for the user
    const tokenResponse = await fetch('https://api.daily.co/v1/meeting-tokens', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.DAILY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          room_name: roomName,
          is_owner: true,
          user_name: user_id,
        }
      }),
    });

    const tokenData = await tokenResponse.json();

    return c.json({
      success: true,
      room: {
        url: roomData.url,
        name: roomData.name,
        token: tokenData.token
      }
    });

  } catch (error: any) {
    console.error('Daily.co room creation error:', error);
    return c.json({ error: 'Failed to create video room' }, 500);
  }
});

// Get room details
daily.get('/room/:roomName', async (c) => {
  try {
    const roomName = c.req.param('roomName');

    const response = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
      headers: {
        'Authorization': `Bearer ${c.env.DAILY_API_KEY}`,
      },
    });

    const roomData = await response.json();

    if (!response.ok) {
      return c.json({ error: 'Room not found' }, 404);
    }

    return c.json({ room: roomData });

  } catch (error: any) {
    console.error('Daily.co room fetch error:', error);
    return c.json({ error: 'Failed to fetch room' }, 500);
  }
});

export default daily;