import { Hono } from 'hono';

export const messages = new Hono();

messages.get('/', (c) => c.json([{ id: 1, content: 'Hello world' }]));
