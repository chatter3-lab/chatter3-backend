import { Hono } from 'hono';
import { users } from './routes/users';
import { rooms } from './routes/rooms';
import { messages } from './routes/messages';

const app = new Hono<{ Bindings: { DB: D1Database } }>();

app.route('/api/users', users);
app.route('/api/rooms', rooms);
app.route('/api/messages', messages);

app.get('/', (c) => c.text('Chatter3 Backend v0.2.0 ✅'));

export default app;
