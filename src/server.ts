import { WebSocketServer, WebSocket } from 'ws';
import { initializeDatabase } from "./db";
import { AuthController } from "./controllers/auth.controller";
import { AccountController } from "./controllers/account.controller";
import * as jwt from "jsonwebtoken";
import { ApiError } from "./utils/apiResponse";
import { AppDataSource } from "./db";
import { Geo_User } from "./entities/user.entity";
import { IncomingMessage } from 'http';
import { Server } from 'http';

// Interface for the parsed WebSocket message
interface Message {
  token: string;
  action: string;
  data?: any;
}

// Interface for JWT payload matching User entity
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

// Track connected clients and their subscriptions
const clients = new Set<WebSocket>();
const channels: Record<string, Set<WebSocket>> = {};

// Create HTTP server
const server = new Server();
const wss = new WebSocketServer({ server });

// Authentication middleware
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

// Subscribe to channel
function subscribe(ws: WebSocket, channel: string) {
  if (!channels[channel]) {
    channels[channel] = new Set();
  }
  channels[channel].add(ws);
}

// Broadcast to channel
function broadcast(channel: string, message: string) {
  if (channels[channel]) {
    channels[channel].forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

// Handle new connections
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  clients.add(ws);
  const url = req.url;

  console.log(`New connection: ${url}`);

  // Handle messages
  ws.on('message', async (message: string) => {
    try {
      const parsedMessage: Message = JSON.parse(message);
      const { token, action, data } = parsedMessage;

      if (url === '/api/auth/logout') {
        await authController.logout(ws);
      } 
      else if (url === '/api/accounts') {
        const user = await authenticate(ws, token);
        if (!user) return;

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
      else if (url === '/api/users') {
        const user = await authenticate(ws, token);
        if (!user) return;

        switch (action) {
          case "create":
            await accountController.createUser(ws, data, user);
            break;
          default:
            ws.send(JSON.stringify(new ApiError(400, "Invalid action")));
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify(new ApiError(500, "Internal server error")));
    }
  });

  // Handle connection close
  ws.on('close', () => {
    clients.delete(ws);
    // Remove from all channels
    Object.keys(channels).forEach(channel => {
      channels[channel].delete(ws);
    });
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;

// Initialize database and start server
initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(error => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  wss.clients.forEach(client => client.close());
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});