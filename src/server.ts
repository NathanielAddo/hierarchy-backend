import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeDatabase } from "./db";
import { AuthController } from "./controllers/auth.controller";
import { AccountController } from "./controllers/account.controller";
import * as jwt from "jsonwebtoken";
import { AppDataSource } from "./db";
import { Geo_User } from "./entities/user.entity";
import { IncomingMessage } from 'http';
import { ApiResponse, ApiError } from "./utils/apiResponse";
import { URL } from 'url';
import dotenv from 'dotenv';
import { Geo_Account } from './entities/account.entity';

dotenv.config();

// Constants
const PING_INTERVAL = 20000;
const CONNECTION_TIMEOUT = 60000;
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

// Interfaces
interface AuthenticatedRequest extends IncomingMessage {
  user?: Geo_User;  // This should match your client.user type
  clientId?: string;
}

interface WebSocketMessage {
  token?: string;
  action: string;
  data?: any;
  messageId?: string;
}

interface JwtPayload {
  id: string;
  email: string;
  role: "admin" | "user";
  adminType?: "limited" | "unlimited";
  accountId: string;
}

// Validate environment variables
const requiredEnvVars = ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize controllers and repositories
const authController = new AuthController();
const accountController = new AccountController();
const userRepository = AppDataSource.getRepository(Geo_User);
const accountRepository = AppDataSource.getRepository(Geo_Account);

// Client management
const clients = new Map<string, { 
  ws: WebSocket; 
  pingInterval: NodeJS.Timeout;
  user?: Geo_User;  // Using undefined instead of null
}>();

const channels: Record<string, Set<WebSocket>> = {};

// Create HTTP server
const server = createServer();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_SIZE
});

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      connections: clients.size,
      uptime: process.uptime()
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Authentication middleware
const authenticate = async (ws: WebSocket, token: string): Promise<Geo_User | undefined> => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    const user = await userRepository.findOne({
      where: { 
        id: decoded.id, 
        email: decoded.email
      },
      relations: ["account"],
    });

    if (!user) {
      ws.send(JSON.stringify(new ApiError(401, "User not found")));
      ws.close(1008, "User not found");
      return undefined;
    }

    return user;
  } catch (error) {
    console.error('Authentication error:', error);
    ws.send(JSON.stringify(new ApiError(401, "Invalid or expired token")));
    ws.close(1008, "Invalid token");
    return undefined;
  }
};

// Channel management
function subscribe(ws: WebSocket, channel: string) {
  if (!channels[channel]) {
    channels[channel] = new Set();
  }
  channels[channel].add(ws);
}

function unsubscribe(ws: WebSocket, channel: string) {
  if (channels[channel]) {
    channels[channel].delete(ws);
    if (channels[channel].size === 0) {
      delete channels[channel];
    }
  }
}

function broadcast(channel: string, message: any) {
  if (channels[channel]) {
    const jsonMessage = JSON.stringify(message);
    channels[channel].forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(jsonMessage);
      }
    });
  }
}

// Client cleanup
function cleanupClient(clientId: string) {
  const client = clients.get(clientId);
  if (client) {
    clearInterval(client.pingInterval);
    clients.delete(clientId);
    Object.keys(channels).forEach(channel => {
      unsubscribe(client.ws, channel);
    });
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(1001, 'Client cleanup');
    }
  }
}

// Upgrade handler for WebSocket connections
server.on('upgrade', (request: AuthenticatedRequest, socket, head) => {
  // CORS validation
  const allowedOrigins = ['https://geo-acc.vercel.app', 'http://localhost:3000'];
  const origin = request.headers.origin ?? null;
  
  if (origin && !allowedOrigins.includes(origin)) {
    console.log(`Forbidden origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Path validation
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  const allowedPaths = ['/api/ws', '/api/auth', '/api/accounts'];
  const isAllowed = allowedPaths.some(path => pathname.startsWith(path));

  if (!isAllowed) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Handle WebSocket upgrade
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// WebSocket connection handler
wss.on('connection', (ws: WebSocket, request: AuthenticatedRequest) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  const clientId = searchParams.get('clientId') || `conn_${Date.now()}`;
  const ip = request.socket.remoteAddress;

  console.log(`New connection: ${clientId} from ${ip} to ${pathname}`);

  // Connection heartbeat
  let isAlive = true;
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      console.log(`Terminating unresponsive connection: ${clientId}`);
      cleanupClient(clientId);
      return;
    }
    isAlive = false;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    } catch (error) {
      console.error(`Ping error for ${clientId}:`, error);
      cleanupClient(clientId);
    }
  }, PING_INTERVAL);

  // Add client to tracking
  clients.set(clientId, { ws, pingInterval });

  // Initial authentication timeout
  const timeout = setTimeout(() => {
    if (clients.has(clientId)) {
      console.log(`Initial auth timeout for ${clientId}`);
      cleanupClient(clientId);
    }
  }, CONNECTION_TIMEOUT);

  // Message handler
  ws.on('message', async (message: string | Buffer) => {
    try {
      const messageStr = message.toString();
      
      // Handle ping/pong
      if (messageStr === 'ping') {
        ws.send('pong');
        isAlive = true;
        return;
      }
      if (messageStr === 'pong') {
        isAlive = true;
        return;
      }

      // Parse message
      const parsedMessage: WebSocketMessage = JSON.parse(messageStr);
      console.log(`Received message from ${clientId}:`, parsedMessage);

      // Clear initial timeout on first message
      clearTimeout(timeout);

      // Route messages based on path
      switch (pathname) {
        case '/api/auth/login':
          await authController.login(ws, parsedMessage.data);
          break;

        case '/api/auth/logout':
          await authController.logout(ws);
          cleanupClient(clientId);
          break;

        case '/api/accounts':
          await handleAccountOperations(ws, parsedMessage, clientId);
          break;

        default:
          // Handle other WebSocket endpoints
          if (parsedMessage.action === 'subscribe') {
            subscribe(ws, parsedMessage.data.channel);
            ws.send(JSON.stringify(new ApiResponse(200, 'Subscribed successfully')));
          } else if (parsedMessage.action === 'unsubscribe') {
            unsubscribe(ws, parsedMessage.data.channel);
            ws.send(JSON.stringify(new ApiResponse(200, 'Unsubscribed successfully')));
          } else {
            ws.send(JSON.stringify(new ApiError(404, 'Endpoint not found')));
          }
      }
    } catch (error) {
      console.error(`Message error from ${clientId}:`, error);
      ws.send(JSON.stringify(new ApiError(400, 'Invalid message format')));
    }
  });

  // Handle account operations
  async function handleAccountOperations(ws: WebSocket, message: WebSocketMessage, clientId: string) {
    const client = clients.get(clientId);
    if (!client) return;

    // Authenticate if not already authenticated
 if (!client.user && message.token) {
    client.user = await authenticate(ws, message.token);
    if (!client.user) return;
  }

    if (!client.user) {
      ws.send(JSON.stringify(new ApiError(401, 'Authentication required')));
      return;
    }

    try {
      switch (message.action) {
        case 'getAccounts':
          await accountController.getAccounts(ws, client.user);
          break;
        case 'getOrganizationUsers':
          await accountController.getOrganizationUsers(ws, client.user, message.token || '');
          break;
        case 'assignUsers':
          await accountController.assignUsers(ws, message.data, client.user);
          break;
        case 'create':
          await accountController.createAccount(ws, message.data, client.user);
          break;
        default:
          ws.send(JSON.stringify(new ApiError(400, 'Invalid action')));
      }
    } catch (error) {
      console.error(`Account operation error for ${clientId}:`, error);
      ws.send(JSON.stringify(new ApiError(500, 'Internal server error')));
    }
  }

  // Connection cleanup
  ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${clientId}, Code: ${code}, Reason: ${reason.toString()}`);
    cleanupClient(clientId);
  });

  ws.on('error', (error) => {
    console.error(`Connection error: ${clientId}`, error);
    cleanupClient(clientId);
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  
  // Close all client connections
  clients.forEach((client, clientId) => {
    cleanupClient(clientId);
  });

  // Close WebSocket server
  await new Promise<void>((resolve) => {
    wss.close(() => {
      console.log('WebSocket server closed');
      resolve();
    });
  });

  // Close HTTP server
  await new Promise<void>((resolve) => {
    server.close(() => {
      console.log('HTTP server closed');
      resolve();
    });
  });

  process.exit(0);
};

// Handle signals
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, shutdown);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Start server
const PORT = parseInt(process.env.PORT || '5111');

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Available WebSocket endpoints:');
    console.log('- /api/auth/login');
    console.log('- /api/auth/logout');
    console.log('- /api/accounts');
    console.log('- /api/ws');
  });
}).catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});