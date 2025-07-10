"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const db_1 = require("./db");
const auth_controller_1 = require("./controllers/auth.controller");
const account_controller_1 = require("./controllers/account.controller");
const jwt = __importStar(require("jsonwebtoken"));
const apiResponse_1 = require("./utils/apiResponse");
const db_2 = require("./db");
const user_entity_1 = require("./entities/user.entity");
const http_1 = require("http");
const authController = new auth_controller_1.AuthController();
const accountController = new account_controller_1.AccountController();
const userRepository = db_2.AppDataSource.getRepository(user_entity_1.Geo_User);
// Track connected clients and their subscriptions
const clients = new Set();
const channels = {};
// Create HTTP server
const server = new http_1.Server();
const wss = new ws_1.WebSocketServer({ server });
// Authentication middleware
const authenticate = async (ws, token) => {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
        const user = await userRepository.findOne({
            where: { id: decoded.id, email: decoded.email },
            relations: ["account"],
        });
        if (!user) {
            ws.send(JSON.stringify(new apiResponse_1.ApiError(401, "User not found")));
            ws.close();
            return null;
        }
        return user;
    }
    catch (error) {
        ws.send(JSON.stringify(new apiResponse_1.ApiError(401, "Invalid token")));
        ws.close();
        return null;
    }
};
// Subscribe to channel
function subscribe(ws, channel) {
    if (!channels[channel]) {
        channels[channel] = new Set();
    }
    channels[channel].add(ws);
}
// Broadcast to channel
function broadcast(channel, message) {
    if (channels[channel]) {
        channels[channel].forEach(client => {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}
// Handle new connections
wss.on('connection', (ws, req) => {
    clients.add(ws);
    const url = req.url;
    console.log(`New connection: ${url}`);
    // Handle messages
    ws.on('message', async (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            const { token, action, data } = parsedMessage;
            if (url === '/api/auth/logout') {
                await authController.logout(ws);
            }
            else if (url === '/api/accounts') {
                const user = await authenticate(ws, token);
                if (!user)
                    return;
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
                        ws.send(JSON.stringify(new apiResponse_1.ApiError(400, "Invalid action")));
                }
            }
            else if (url === '/api/users') {
                const user = await authenticate(ws, token);
                if (!user)
                    return;
                switch (action) {
                    case "create":
                        await accountController.createUser(ws, data, user);
                        break;
                    default:
                        ws.send(JSON.stringify(new apiResponse_1.ApiError(400, "Invalid action")));
                }
            }
        }
        catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify(new apiResponse_1.ApiError(500, "Internal server error")));
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
(0, db_1.initializeDatabase)().then(() => {
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
