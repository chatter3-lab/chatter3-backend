import { Hono } from 'hono';

// Store active connections
const connections = new Map();

export const webrtc = new Hono();

// WebSocket signaling for WebRTC
webrtc.get('/ws/:sessionId/:userId', (c) => {
  const sessionId = c.req.param('sessionId');
  const userId = c.req.param('userId');
  
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();
  
  console.log(`WebSocket connected: ${sessionId}_${userId}`);

  // Store connection
  const connectionKey = `${sessionId}_${userId}`;
  connections.set(connectionKey, server);

  // Send welcome message
  server.send(JSON.stringify({
    type: 'welcome',
    userId: userId,
    sessionId: sessionId
  }));

  // Notify partner if they're connected
  const partnerId = getPartnerId(sessionId, userId);
  const partnerKey = `${sessionId}_${partnerId}`;
  const partnerConnection = connections.get(partnerKey);
  
  if (partnerConnection) {
    partnerConnection.send(JSON.stringify({
      type: 'partner-connected',
      partnerId: userId
    }));
    
    server.send(JSON.stringify({
      type: 'partner-connected', 
      partnerId: partnerId
    }));
  }

  // Handle messages
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Received message:', data.type, 'from', userId);
      
      // Forward message to partner
      const partnerId = getPartnerId(sessionId, userId);
      const partnerKey = `${sessionId}_${partnerId}`;
      const partnerConnection = connections.get(partnerKey);
      
      if (partnerConnection && partnerConnection.readyState === WebSocket.OPEN) {
        console.log('Forwarding to partner:', partnerId);
        partnerConnection.send(JSON.stringify({
          fromUserId: userId,
          type: data.type,
          data: data.data
        }));
      } else {
        console.log('Partner not connected:', partnerId);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  // Handle cleanup
  server.addEventListener('close', () => {
    console.log(`WebSocket closed: ${connectionKey}`);
    connections.delete(connectionKey);
    
    // Notify partner
    const partnerId = getPartnerId(sessionId, userId);
    const partnerKey = `${sessionId}_${partnerId}`;
    const partnerConnection = connections.get(partnerKey);
    
    if (partnerConnection) {
      partnerConnection.send(JSON.stringify({
        type: 'partner-disconnected',
        partnerId: userId
      }));
    }
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

// Helper function to determine partner ID
function getPartnerId(sessionId: string, userId: string): string {
  // Extract user IDs from session ID format
  const parts = sessionId.split('_');
  if (parts.length >= 3) {
    const user1Id = parts[1];
    const user2Id = parts[2];
    return userId === user1Id ? user2Id : user1Id;
  }
  return '';
}

export default webrtc;