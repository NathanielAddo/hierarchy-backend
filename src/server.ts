import * as uWS from "uWebSockets.js";
import { initializeDatabase } from "./db";
import { AuthController } from "./controllers/auth.controller";
import { AccountController } from "./controllers/account.controller";
import { ApiError } from "./utils/api-error";
import * as jwt from "jsonwebtoken";
import { JwtPayload } from "jsonwebtoken";
import { User } from "./entities/user.entity";
import { getRepository } from "typeorm";

// Define WebSocket interface for uWebSockets.js
interface WebSocket {
  send(message: string): void;
  subscribe(topic: string): void;
  close(): void;
}

// Define JWT payload to match User entity
interface UserJwtPayload extends JwtPayload {
  id: string;
  email: string;
  role: "admin" | "user";
  adminType?: "limited" | "unlimited";
}

const authController = new AuthController();
const accountController = new AccountController();

const app = uWS.App();

const authenticate = async (ws: WebSocket, token: string): Promise<User | null> => {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "secret") as UserJwtPayload;
    const userRepository = getRepository(User);
    const user = await userRepository.findOne({ 
      where: { id: payload.id }, 
      relations: ["account"] 
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

app.ws("/api/auth/login", {
  open: async (ws: WebSocket) => {
    ws.subscribe("auth");
  },
  message: async (ws: WebSocket, message: Buffer) => {
    const data = JSON.parse(Buffer.from(message).toString());
    await authController.login(ws, data);
  },
});

app.ws("/api/auth/logout", {
  open: async (ws: WebSocket) => {
    ws.subscribe("auth");
  },
  message: async (ws: WebSocket, message: Buffer) => {
    await authController.logout(ws);
  },
});

app.ws("/api/accounts", {
  open: async (ws: WebSocket) => {
    ws.subscribe("accounts");
  },
  message: async (ws: WebSocket, message: Buffer) => {
    const { token, action, data } = JSON.parse(Buffer.from(message).toString());
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
      default:
        ws.send(JSON.stringify(new ApiError(400, "Invalid action")));
    }
  },
});

app.ws("/api/users", {
  open: async (ws: WebSocket) => {
    ws.subscribe("users");
  },
  message: async (ws: WebSocket, message: Buffer) => {
    const { token, action, data } = JSON.parse(Buffer.from(message).toString());
    const user = await authenticate(ws, token);
    if (!user) return;

    switch (action) {
      case "create":
        await accountController.createUser(ws, data, user);
        break;
      default:
        ws.send(JSON.stringify(new ApiError(400, "Invalid action")));
    }
  },
});

const PORT = process.env.PORT || 3000;

initializeDatabase().then(() => {
  app.listen(PORT, (token: boolean) => {
    if (token) {
      console.log(`Server running on port ${PORT}`);
    } else {
      console.error("Failed to start server");
    }
  });
});