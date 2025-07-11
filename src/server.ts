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

dotenv.config();

// Configuration constants
const PING_INTERVAL = 20000; // 20 seconds
const CONNECTION_TIMEOUT = 30000; // 30 seconds
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

interface Message {
  token: string;
  action: string;
  data?: any;
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

const authController = new AuthController();
const accountController = new AccountController();
const userRepository = AppDataSource.getRepository(Geo_User);

const clients = new Map<string, { ws: WebSocket, pingInterval: NodeJS.Timeout }>();
const channels: Record<string, Set<WebSocket>> = {};

const server = createServer();
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_SIZE
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
      connections: clients.size
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const authenticate = async (ws: WebSocket, token: string): Promise<Geo_User | null> => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    const user = await userRepository.findOne({
      where: { 
        id: decoded.id, 
        email: decoded.email,
        role: 'admin'
      },
      relations: ["account"],
    });
    
    if (!user) {
      ws.send(JSON.stringify(new ApiError(401, "Admin user not found")));
      ws.close(1008, "Admin user not found");
      return null;
    }
    return user;
  } catch (error) {
    console.error('Authentication error:', error);
    ws.send(JSON.stringify(new ApiError(401, "Invalid or expired token")));
    ws.close(1008, "Invalid token");
    return null;
  }
};

function subscribe(ws: WebSocket, channel: string) {
  if (!channels[channel]) {
    channels[channel] = new Set();
  }
  channels[channel].add(ws);
}

function cleanupClient(clientId: string) {
  const client = clients.get(clientId);
  if (client) {
    clearInterval(client.pingInterval);
    clients.delete(clientId);
    
    // Remove from all channels
    Object.keys(channels).forEach(channel => {
      channels[channel].delete(client.ws);
    });
    
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(1001, 'Cleanup');
    }
  }
}

server.on('upgrade', (request, socket, head) => {
  const allowedOrigins = [
    'https://geo-acc.vercel.app',
    'http://localhost:3000'
  ];
  
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  const allowedPaths = ['/api/auth/login', '/api/auth/logout', '/api/ws'];
  
  if (!allowedPaths.includes(pathname)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  const clientId = searchParams.get('clientId') || `conn_${Date.now()}`;
  const ip = request.socket.remoteAddress;

  console.log(`New connection: ${clientId} from ${ip} to ${pathname}`);

  // Setup ping/pong heartbeat
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

  clients.set(clientId, { ws, pingInterval });

  // Setup initial timeout
  const timeout = setTimeout(() => {
    if (clients.has(clientId)) {
      console.log(`Initial auth timeout for ${clientId}`);
      cleanupClient(clientId);
    }
  }, CONNECTION_TIMEOUT);

  ws.on('pong', () => {
    isAlive = true;
    // Clear initial timeout after first pong
    clearTimeout(timeout);
  });

  ws.on('message', async (message: string) => {
    try {
      const parsedMessage: Message = JSON.parse(message);
      const { token, action, data } = parsedMessage;

      if (pathname === '/api/auth/login') {
        await authController.login(ws, data);
      } 
      else if (pathname === '/api/auth/logout') {
        await authController.logout(ws);
        cleanupClient(clientId);
      } 
      else {
        const user = await authenticate(ws, token);
        if (!user) return;

        // Handle authorized actions...
      }
    } catch (error) {
      console.error(`Message error from ${clientId}:`, error);
      ws.send(JSON.stringify(new ApiError(500, "Internal server error")));
    }
  });

  ws.on('close', () => {
    console.log(`Closed: ${clientId}`);
    cleanupClient(clientId);
  });

  ws.on('error', (error) => {
    console.error(`Error: ${clientId}`, error);
    cleanupClient(clientId);
  });
});

const PORT = parseInt(process.env.PORT || '5111');

// Graceful shutdown
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`${signal} received. Shutting down gracefully...`);
    
    // Close all WebSocket connections
    clients.forEach((client, clientId) => {
      cleanupClient(clientId);
    });
    
    // Close the WebSocket server
    wss.close(() => {
      console.log('WebSocket server closed');
      
      // Close the HTTP server
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    });
  });
});

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Available WebSocket endpoints:');
    console.log('- /api/auth/login');
    console.log('- /api/auth/logout');
    console.log('- /api/ws');
  });
}).catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});