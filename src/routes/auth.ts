import { Hono } from 'hono';
import { jwtVerify } from 'hono/jwt';

export const auth = new Hono<{ Bindings: { DB: D1Database; GOOGLE_CLIENT_ID: string } }>();

// Google OAuth verification - SIMPLIFIED FOR TESTING
auth.post('/google', async (c) => {
  try {
    const { credential, email, name } = await c.req.json();
    
    // For MVP testing, accept direct email/name or mock credential
    let userEmail = email;
    let userName = name;
    let googleId = `mock_${crypto.randomUUID()}`;

    if (credential && credential !== 'header.payload.signature') {
      try {
        // Simple JWT parsing for testing
        const tokenParts = credential.split('.');
        if (tokenParts.length === 3) {
          const payloadJson = atob(tokenParts[1]);
          const payload = JSON.parse(payloadJson);
          userEmail = payload.email || userEmail;
          userName = payload.name || userName;
          googleId = payload.sub || googleId;
        }
      } catch (parseError) {
        console.log('JWT parsing failed, using fallback data');
      }
    }

    if (!userEmail) {
      return c.json({ error: 'Email is required' }, 400);
    }

    // Check if user exists by google_id or email
    let user = await c.env.DB.prepare(
      'SELECT * FROM users WHERE google_id = ? OR email = ?'
    ).bind(googleId, userEmail).first();

    if (!user) {
      // Create new user
      const id = crypto.randomUUID();
      const username = userName?.replace(/\s+/g, '_').toLowerCase() || userEmail.split('@')[0];
      
      user = {
        id,
        google_id: googleId,
        email: userEmail,
        username,
        english_level: 'beginner',
        points: 0,
        created_at: new Date().toISOString()
      };

      await c.env.DB.prepare(
        'INSERT INTO users (id, google_id, email, username, english_level, points) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.id, user.google_id, user.email, user.username, user.english_level, user.points).run();
    }

    // Update last_active
    await c.env.DB.prepare(
      'UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(user.id).run();

    return c.json({ 
      success: true, 
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        english_level: user.english_level,
        points: user.points
      }
    });

  } catch (error: any) {
    console.error('Google auth error:', error);
    return c.json({ error: 'Authentication failed', details: error.message }, 500);
  }
});

// Email registration
auth.post('/register', async (c) => {
  try {
    const { email, username, english_level = 'beginner' } = await c.req.json();

    if (!email || !username) {
      return c.json({ error: 'Email and username are required' }, 400);
    }

    // Check if email already exists
    const existingUser = await c.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();

    if (existingUser) {
      return c.json({ error: 'Email already registered' }, 400);
    }

    const id = crypto.randomUUID();

    await c.env.DB.prepare(
      'INSERT INTO users (id, email, username, english_level, points) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, email, username, english_level, 0).run();

    // Get the created user
    const user = await c.env.DB.prepare(
      'SELECT id, username, email, english_level, points FROM users WHERE id = ?'
    ).bind(id).first();

    return c.json({ 
      success: true,
      user
    });

  } catch (error: any) {
    console.error('Registration error:', error);
    
    if (error.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: 'Email already registered' }, 400);
    }
    
    return c.json({ error: 'Registration failed', details: error.message }, 500);
  }
});

// Get user profile
auth.get('/me', async (c) => {
  try {
    // This would normally use session/token authentication
    // For now, we'll require user ID in query params for testing
    const userId = c.req.query('user_id');
    
    if (!userId) {
      return c.json({ error: 'User ID required' }, 400);
    }

    const user = await c.env.DB.prepare(
      'SELECT id, username, email, english_level, points, last_active FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({ user });
  } catch (error: any) {
    console.error('Get user error:', error);
    return c.json({ error: 'Failed to get user' }, 500);
  }
});

// Update user profile
auth.put('/profile', async (c) => {
  try {
    const { user_id, english_level, username } = await c.req.json();

    if (!user_id) {
      return c.json({ error: 'User ID required' }, 400);
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (english_level) {
      updates.push('english_level = ?');
      values.push(english_level);
    }

    if (username) {
      updates.push('username = ?');
      values.push(username);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    values.push(user_id);

    await c.env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')}, last_active = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(...values).run();

    // Get updated user
    const user = await c.env.DB.prepare(
      'SELECT id, username, email, english_level, points FROM users WHERE id = ?'
    ).bind(user_id).first();

    return c.json({ 
      success: true,
      user
    });

  } catch (error: any) {
    console.error('Update profile error:', error);
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// Test endpoint
auth.get('/test', (c) => {
  return c.json({ message: 'Auth route is working!' });
});