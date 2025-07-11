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

const clients = new Set<WebSocket>();
const channels: Record<string, Set<WebSocket>> = {};

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const authenticate = async (ws: WebSocket, token: string): Promise<Geo_User | null> => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret") as JwtPayload;
    const user = await userRepository.findOne({
      where: { id: decoded.id, email: decoded.email },
      relations: ["account"],
    });
    
    if (!user) {
      ws.send(JSON.stringify(new ApiError(401, "User not found")));
      ws.close();
      return null;
    }
    return user;
  } catch (error) {
    ws.send(JSON.stringify(new ApiError(401, "Invalid token")));
    ws.close();
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
  
  // Validate origin and path
  if (origin && allowedOrigins.includes(origin) && 
      (pathname === '/api/auth/login' || pathname === '/api/auth/logout' || pathname === '/api/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
  clients.add(ws);
  const url = request.url;
  const { pathname, searchParams } = new URL(url || '', `http://${request.headers.host}`);

  console.log(`New WebSocket connection: ${url}`);

  // Handle initial token if provided in query params
  const token = searchParams.get('token');
  if (token) {
    authenticate(ws, token).then(user => {
      if (user) {
        subscribe(ws, `user-${user.id}`);
      }
    });
  }

  // Connection health check
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('pong', () => {
    console.log('Received pong from client');
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
      console.error('Error handling message:', error);
      ws.send(JSON.stringify(new ApiError(500, "Internal server error")));
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(ws);
    Object.keys(channels).forEach(channel => {
      channels[channel].delete(ws);
    });
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

const PORT = process.env.PORT || 5111;

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  wss.clients.forEach(client => client.close());
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});