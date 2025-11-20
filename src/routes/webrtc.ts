import { Hono } from 'hono';

// Store active connections (in production, we will use Redis/Durable Objects)
const connections = new Map();

export const webrtc = new Hono<{ Bindings: { DB: D1Database } }>();

// WebSocket signaling for WebRTC
webrtc.get('/ws/:sessionId/:userId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const userId = c.req.param('userId');
  
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();

  // Store connection
  const connectionKey = `${sessionId}_${userId}`;
  connections.set(connectionKey, server);

  // Handle messages
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Forward message to partner
      const partnerId = data.toUserId;
      const partnerKey = `${sessionId}_${partnerId}`;
      const partnerConnection = connections.get(partnerKey);
      
      if (partnerConnection) {
        partnerConnection.send(JSON.stringify({
          fromUserId: userId,
          type: data.type,
          data: data.data
        }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  // Handle cleanup
  server.addEventListener('close', () => {
    connections.delete(connectionKey);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

// Get STUN/TURN servers (optional - using free STUN for now)
webrtc.get('/ice-servers', (c) => {
  return c.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  });
});

export default webrtc;