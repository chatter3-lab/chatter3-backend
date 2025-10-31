import { Hono } from 'hono';

export const rooms = new Hono<{ Bindings: { DB: D1Database } }>();

rooms.get('/', async (c) => {
  try {
    console.log('Fetching rooms...');
    
    // Test if we can connect to the database first
    const test = await c.env.DB.prepare('SELECT 1 as test').first();
    console.log('Database connection test:', test);
    
    // Check if rooms table exists
    const tableCheck = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'"
    ).first();
    console.log('Table check:', tableCheck);
    
    // Get rooms
    const result = await c.env.DB.prepare(
      "SELECT * FROM rooms"
    ).all();
    console.log('Rooms result:', result);
    
    return c.json(result.results || []);
  } catch (error: any) {
    console.error('Rooms route error:', error);
    return c.json({ 
      error: 'Internal Server Error',
      message: error.message,
      details: 'Check Worker logs for more information'
    }, 500);
  }
});
