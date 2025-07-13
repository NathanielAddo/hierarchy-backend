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

const PING_INTERVAL = 20000;
const CONNECTION_TIMEOUT = 60000;
const MAX_PAYLOAD_SIZE = 1024 * 1024;

interface AuthenticatedRequest extends IncomingMessage {
  user?: Geo_User;
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

interface ClientConnection {
  ws: WebSocket;
  pingInterval: NodeJS.Timeout;
  user?: Geo_User;
  lastActivity?: number;
  messageCount?: number;
}

const requiredEnvVars = ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const authController = new AuthController();
const accountController = new AccountController();
const userRepository = AppDataSource.getRepository(Geo_User);
const accountRepository = AppDataSource.getRepository(Geo_Account);

const clients = new Map<string, ClientConnection>();
const channels: Record<string, Set<WebSocket>> = {};

const server = createServer();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_SIZE
});

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

server.on('upgrade', (request: AuthenticatedRequest, socket, head) => {
  const allowedOrigins = ['https://geo-acc.vercel.app', 'http://localhost:3000'];
  const origin = request.headers.origin ?? null;
  
  if (origin && !allowedOrigins.includes(origin)) {
    console.log(`Forbidden origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  const allowedPaths = [
    '/api/ws',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/accounts'
  ];
  
  const isAllowed = allowedPaths.some(path => pathname.startsWith(path));
  
  if (!isAllowed) {
    console.log(`Invalid path attempted: ${pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (origin && allowedOrigins.includes(origin)) {
      ws.on('headers', (headers) => {
        headers.push('Access-Control-Allow-Origin', origin);
        headers.push('Access-Control-Allow-Credentials', 'true');
      });
    }
    
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws: WebSocket, request: AuthenticatedRequest) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  const clientId = searchParams.get('clientId') || `conn_${Date.now()}`;
  const ip = request.socket.remoteAddress;

  console.log(`New connection: ${clientId} from ${ip} to ${pathname}`);

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

  clients.set(clientId, { 
    ws, 
    pingInterval,
    lastActivity: Date.now(),
    messageCount: 0
  });

  const timeout = setTimeout(() => {
    if (clients.has(clientId)) {
      console.log(`Initial auth timeout for ${clientId}`);
      cleanupClient(clientId);
    }
  }, CONNECTION_TIMEOUT);

  ws.on('message', async (message: string | Buffer) => {
    try {
      const messageStr = message.toString();
      
      if (messageStr === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('pong');
        }
        return;
      }
      
      if (messageStr === 'pong') {
        const client = clients.get(clientId);
        if (client) {
          client.lastActivity = Date.now();
          isAlive = true;
        }
        return;
      }

      const client = clients.get(clientId);
      if (client && client.messageCount && client.messageCount > 100) {
        throw new ApiError(429, 'Too many requests');
      }

      let parsedMessage: WebSocketMessage;
      try {
        parsedMessage = JSON.parse(messageStr);
      } catch (error) {
        throw new ApiError(400, 'Invalid JSON format');
      }

      if (!parsedMessage.action || typeof parsedMessage.action !== 'string') {
        throw new ApiError(400, 'Message must contain an action');
      }

      if (client) {
        client.messageCount = (client.messageCount || 0) + 1;
        client.lastActivity = Date.now();
      }

      clearTimeout(timeout);

      switch (true) {
        case parsedMessage.action.startsWith('/auth/login'):
          await authController.login(ws, parsedMessage.data);
          break;
          
        case parsedMessage.action.startsWith('/auth/logout'):
          await authController.logout(ws);
          cleanupClient(clientId);
          break;
          
        case parsedMessage.action.startsWith('/accounts'):
          await handleAccountOperations(ws, parsedMessage, clientId);
          break;
          
        default:
          throw new ApiError(404, 'Endpoint not found');
      }

    } catch (error) {
      console.error(`Message error from ${clientId}:`, error);
      
      if (ws.readyState === WebSocket.OPEN) {
        const errorResponse = error instanceof ApiError
          ? error
          : new ApiError(500, 'Internal server error');
        
        ws.send(JSON.stringify({
          status: errorResponse.status,
          message: errorResponse.message,
          timestamp: Date.now()
        }));
      }
      
      if (error instanceof ApiError && error.status >= 500) {
        cleanupClient(clientId);
      }
    }
  });

  async function handleAccountOperations(ws: WebSocket, message: WebSocketMessage, clientId: string) {
    const client = clients.get(clientId);
    if (!client) return;

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

  ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${clientId}, Code: ${code}, Reason: ${reason.toString()}`);
    cleanupClient(clientId);
  });

  ws.on('error', (error) => {
    console.error(`Connection error: ${clientId}`, error);
    cleanupClient(clientId);
  });
});

const shutdown = async () => {
  console.log('Shutting down gracefully...');
  
  clients.forEach((client, clientId) => {
    cleanupClient(clientId);
  });

  await new Promise<void>((resolve) => {
    wss.close(() => {
      console.log('WebSocket server closed');
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.close(() => {
      console.log('HTTP server closed');
      resolve();
    });
  });

  process.exit(0);
};

['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, shutdown);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

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