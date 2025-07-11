import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeDatabase } from "./db";
import { AuthController } from "./controllers/auth.controller";
import { AccountController } from "./controllers/account.controller";
import * as jwt from "jsonwebtoken";
import { ApiError } from "./utils/apiResponse";
import { AppDataSource } from "./db";
import { Geo_User } from "./entities/user.entity";
import { IncomingMessage } from 'http';
import { URL } from 'url';
import dotenv from 'dotenv';

dotenv.config();

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

// Validate required environment variables
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

const clients = new Map<string, WebSocket>();
const channels: Record<string, Set<WebSocket>> = {};
const connectionTimeouts = new Map<string, NodeJS.Timeout>();

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

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
  const ws = clients.get(clientId);
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1001, 'Cleanup');
    }
    clients.delete(clientId);
    
    // Clear any pending timeout
    const timeout = connectionTimeouts.get(clientId);
    if (timeout) clearTimeout(timeout);
    connectionTimeouts.delete(clientId);
    
    // Remove from all channels
    Object.keys(channels).forEach(channel => {
      channels[channel].delete(ws);
    });
  }
}

server.on('upgrade', (request, socket, head) => {
  try {
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
  } catch (error) {
    console.error('Upgrade error:', error);
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  const clientId = searchParams.get('clientId') || `conn_${Date.now()}`;
  const ip = request.socket.remoteAddress;

  console.log(`New connection: ${clientId} from ${ip} to ${pathname}`);
  clients.set(clientId, ws);

  // Connection health monitoring
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
  }, 25000);

  // Setup connection timeout
  const timeout = setTimeout(() => {
    console.log(`Connection timeout for ${clientId}`);
    cleanupClient(clientId);
  }, 30000);
  connectionTimeouts.set(clientId, timeout);

  // Handle initial authentication if token provided
  const token = searchParams.get('token');
  if (token) {
    authenticate(ws, token).then(user => {
      if (user) {
        subscribe(ws, `user_${user.id}`);
        console.log(`Authenticated: ${user.email} as ${clientId}`);
        
        // Clear the initial timeout after successful auth
        const timeout = connectionTimeouts.get(clientId);
        if (timeout) clearTimeout(timeout);
        connectionTimeouts.delete(clientId);
      }
    }).catch(error => {
      console.error(`Auth error for ${clientId}:`, error);
    });
  }

  ws.on('pong', () => {
    isAlive = true;
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

        // Handle authorized actions
        if (pathname === '/api/accounts') {
          switch (action) {
            case "create":
              await accountController.createAccount(ws, data, user);
              break;
            case "assignUsers":
              await accountController.assignUsers(ws, data, user);
              break;
            case "getAccounts":
              await accountController.getAccounts(ws, user);
              break;
            case "getOrganizationUsers":
              await accountController.getOrganizationUsers(ws, user, token);
              break;
            default:
              ws.send(JSON.stringify(new ApiError(400, "Invalid action")));
          }
        }
        else if (pathname === '/api/users') {
          switch (action) {
            case "create":
              await accountController.createUser(ws, data, user);
              break;
            default:
              ws.send(JSON.stringify(new ApiError(400, "Invalid action")));
          }
        }
      }
    } catch (error) {
      console.error(`Message error from ${clientId}:`, error);
      ws.send(JSON.stringify(new ApiError(500, "Internal server error")));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`Closed: ${clientId} (${code}) ${reason.toString()}`);
    cleanupClient(clientId);
    clearInterval(pingInterval);
  });

  ws.on('error', (error) => {
    console.error(`Error: ${clientId}`, error);
    cleanupClient(clientId);
    clearInterval(pingInterval);
  });
});

const PORT = parseInt(process.env.PORT || '5111');

// Graceful shutdown handler
function gracefulShutdown(signal: string) {
  return () => {
    console.log(`${signal} received. Shutting down gracefully...`);
    
    // Close all WebSocket connections
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
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
  };
}

process.on('SIGTERM', gracefulShutdown('SIGTERM'));
process.on('SIGINT', gracefulShutdown('SIGINT'));

// Initialize and start server
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