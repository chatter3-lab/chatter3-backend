import { Hono } from 'hono';
import { DB } from '../db';

export const users = new Hono<{ Bindings: { DB: D1Database } }>();

users.get('/', async (c) => {
  const db = new DB(c.env.DB);
  const res = await db.allUsers();
  return c.json(res.results);
});

users.post('/', async (c) => {
  const { username } = await c.req.json();
  const db = new DB(c.env.DB);
  await db.createUser(username);
  return c.json({ message: 'User created' });
});
