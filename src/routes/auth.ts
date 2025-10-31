import { Hono } from 'hono';

export const auth = new Hono<{ Bindings: { DB: D1Database; GOOGLE_CLIENT_ID: string } }>();

// Simple test endpoint
auth.get('/test', (c) => {
  return c.json({ message: 'Auth route is working!' });
});

// Google OAuth placeholder
auth.post('/google', async (c) => {
  return c.json({ message: 'Google auth endpoint - to be implemented' });
});

// Email registration placeholder  
auth.post('/register', async (c) => {
  return c.json({ message: 'Registration endpoint - to be implemented' });
});