import { Hono } from 'hono';

// In-memory store for connections (use Durable Objects in production)
const connections = new Map();

export const webrtc = new Hono();

// WebSocket handler
webrtc.get('/ws/:sessionId/:userId', (c) => {
  // Cloudflare Workers handle WebSockets automatically
  // The Worker runtime will handle the upgrade
  
  const sessionId = c.req.param('sessionId');
  const userId = c.req.param('userId');
  
  console.log(`WebSocket request: ${sessionId} - ${userId}`);
  
  // Return a response that indicates we want to upgrade to WebSocket
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  // Create WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  // Accept the WebSocket connection
  server.accept();
  
  const connectionKey = `${sessionId}_${userId}`;
  console.log(`WebSocket connected: ${connectionKey}`);
  
  // Store the connection
  connections.set(connectionKey, server);

  // Handle messages from client
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log(`Message from ${userId}: ${data.type}`);
      
      // Find partner and forward message
      const partnerId = getPartnerId(sessionId, userId);
      const partnerKey = `${sessionId}_${partnerId}`;
      const partnerConnection = connections.get(partnerKey);
      
      if (partnerConnection && partnerConnection.readyState === WebSocket.OPEN) {
        console.log(`Forwarding to partner: ${partnerId}`);
        partnerConnection.send(JSON.stringify({
          fromUserId: userId,
          type: data.type,
          data: data.data
        }));
      } else {
        console.log(`Partner ${partnerId} not connected or ready`);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  // Handle connection close
  server.addEventListener('close', () => {
    console.log(`WebSocket closed: ${connectionKey}`);
    connections.delete(connectionKey);
  });

  // Handle errors
  server.addEventListener('error', (error) => {
    console.error(`WebSocket error for ${connectionKey}:`, error);
  });

  // Return WebSocket response
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

// Helper to get partner ID from session
function getPartnerId(sessionId: string, userId: string): string {
  // Session ID format: session_user1Id_user2Id
  const parts = sessionId.split('_');
  if (parts.length >= 3) {
    const user1Id = parts[1];
    const user2Id = parts[2];
    return userId === user1Id ? user2Id : user1Id;
  }
  return '';
}

// Fallback: HTTP-based signaling for debugging
webrtc.post('/signal/:sessionId/:userId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const userId = c.req.param('userId');
  const { type, data, toUserId } = await c.req.json();
  
  console.log(`HTTP Signal: ${type} from ${userId} to ${toUserId}`);
  
  const partnerKey = `${sessionId}_${toUserId}`;
  const partnerConnection = connections.get(partnerKey);
  
  if (partnerConnection && partnerConnection.readyState === WebSocket.OPEN) {
    partnerConnection.send(JSON.stringify({
      fromUserId: userId,
      type: type,
      data: data
    }));
    return c.json({ success: true });
  }
  
  return c.json({ error: 'Partner not connected' }, 400);
});

webrtc.get('/test', (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  
  if (upgradeHeader === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    server.accept();
    server.send(JSON.stringify({ message: 'WebSocket test successful!' }));
    
    return new Response(null, { status: 101, webSocket: client });
  }
  
  return c.json({ message: 'Send with Upgrade: websocket header to test WebSocket' });
});

export default webrtc;