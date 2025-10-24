import { Hono } from 'hono';
import { DB } from '../db';

export const rooms = new Hono<{ Bindings: { DB: D1Database } }>();

rooms.get('/', async (c) => {
  const db = new DB(c.env.DB);
  const res = await db.allRooms();
  return c.json(res.results);
});

rooms.post('/', async (c) => {
  const { name, createdBy } = await c.req.json();
  const db = new DB(c.env.DB);
  await db.createRoom(name, createdBy);
  return c.json({ message: 'Room created' });
});
