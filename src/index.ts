import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { users } from './routes/users';
import { rooms } from './routes/rooms';
import { messages } from './routes/messages';
import { auth } from './routes/auth';
import { matching } from './routes/matching';
import { webrtc } from './routes/webrtc';
import { daily } from './routes/daily';

const app = new Hono<{ Bindings: { DB: D1Database; GOOGLE_CLIENT_ID: string } }>();

// Middleware
app.use('*', cors({
  origin: ['https://app.chatter3.com', 'http://localhost:5173'],
}));

app.use('*', async (c, next) => {
  console.log(`${c.req.method} ${c.req.path}`);
  await next();
});

// Routes
app.route('/api/users', users);
app.route('/api/rooms', rooms);
app.route('/api/messages', messages);
app.route('/api/auth', auth);
app.route('/api/matching', matching);
app.route('/api/webrtc', webrtc);
app.route('/api/daily', daily);

// Health check
app.get('/', (c) => c.text('Chatter3 Backend ✅'));

// Global error handling
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;