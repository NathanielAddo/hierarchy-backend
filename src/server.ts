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

const authController = new AuthController();
const accountController = new AccountController();
const userRepository = AppDataSource.getRepository(Geo_User);

const clients = new Map<string, WebSocket>();
const channels: Record<string, Set<WebSocket>> = {};

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

// Enhanced authenticate function with better error handling
const authenticate = async (ws: WebSocket, token: string): Promise<Geo_User | null> => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret") as JwtPayload;
    const user = await userRepository.findOne({
      where: { id: decoded.id, email: decoded.email },
      relations: ["account"],
    });
    
    if (!user) {
      ws.send(JSON.stringify(new ApiError(401, "User not found")));
      ws.close(1008, "User not found");
      return null;
    }
    return user;
  } catch (error) {
    console.error('Authentication error:', error);
    ws.send(JSON.stringify(new ApiError(401, "Invalid token")));
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

function broadcast(channel: string, message: string) {
  if (channels[channel]) {
    channels[channel].forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      } else {
        channels[channel].delete(client);
      }
    });
  }
}

server.on('upgrade', (request, socket, head) => {
  const allowedOrigins = [
    'https://geo-acc.vercel.app',
    'http://localhost:3000'
  ];
  
  const origin = request.headers.origin;
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  
  if (origin && allowedOrigins.includes(origin) && 
      ['/api/auth/login', '/api/auth/logout', '/api/ws'].includes(pathname)) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.log(`Rejected connection from ${origin} to ${pathname}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  const { pathname, searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
  const clientId = searchParams.get('clientId') || Date.now().toString();
  clients.set(clientId, ws);

  console.log(`New WebSocket connection: ${pathname} (Client ID: ${clientId})`);

  // Handle initial token if provided
  const token = searchParams.get('token');
  if (token) {
    authenticate(ws, token).then(user => {
      if (user) {
        subscribe(ws, `user-${user.id}`);
        console.log(`User ${user.email} authenticated and subscribed`);
      }
    });
  }

  // Connection health monitoring
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`Sent ping to client ${clientId}`);
    }
  }, 25000);

  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1008, 'Connection timeout');
    }
  }, 30000);

  ws.on('pong', () => {
    console.log(`Received pong from client ${clientId}`);
    clearTimeout(connectionTimeout);
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
            // ... other cases
          }
        }
      }
    } catch (error) {
      console.error(`Error handling message from ${clientId}:`, error);
      ws.send(JSON.stringify(new ApiError(500, "Internal server error")));
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(pingInterval);
    clearTimeout(connectionTimeout);
    clients.delete(clientId);
    Object.keys(channels).forEach(channel => {
      channels[channel].delete(ws);
    });
    console.log(`Client ${clientId} disconnected. Code: ${code}, Reason: ${reason}`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
  });
});

const PORT = process.env.PORT || 5111;

// Enhanced shutdown handling
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    console.log(`${signal} received. Shutting down gracefully...`);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    });
    wss.close(() => {
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  });
});

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('WebSocket endpoints:');
    console.log('- wss://yourdomain.com/api/auth/login');
    console.log('- wss://yourdomain.com/api/auth/logout');
    console.log('- wss://yourdomain.com/api/ws');
  });
}).catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});