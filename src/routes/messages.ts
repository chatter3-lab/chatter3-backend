import { Hono } from 'hono';

export const messages = new Hono<{ Bindings: { DB: D1Database } }>();

messages.get('/', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT * FROM messages"
    ).all();
    
    return c.json(result.results || []);
  } catch (error: any) {
    console.error('Messages error:', error);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});