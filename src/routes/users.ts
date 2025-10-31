import { Hono } from 'hono';

export const users = new Hono<{ Bindings: { DB: D1Database } }>();

users.get('/', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT * FROM users"
    ).all();
    return c.json(result.results || []);
  } catch (error) {
    console.error('Database error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

users.post('/', async (c) => {
  try {
    const { username } = await c.req.json();
    const id = crypto.randomUUID();
    
    await c.env.DB.prepare(
      "INSERT INTO users (id, username, email) VALUES (?, ?, ?)"
    ).run(id, username, `${username}@example.com`);
    
    return c.json({ message: 'User created', id });
  } catch (error) {
    console.error('Database error:', error);
    return c.json({ error: 'Failed to create user' }, 500);
  }
});
