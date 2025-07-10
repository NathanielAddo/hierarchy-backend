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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeDatabase = exports.AppDataSource = void 0;
const typeorm_1 = require("typeorm");
const account_entity_1 = require("./entities/account.entity");
const user_entity_1 = require("./entities/user.entity");
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs"));
const axios_1 = __importDefault(require("axios"));
dotenv.config();
console.log("📦 Loaded Environment Variables:");
console.table({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD ? '***' : undefined,
    DB_NAME: process.env.DB_NAME,
});
const caCert = fs.existsSync("ca-certificate.crt")
    ? fs.readFileSync("ca-certificate.crt")
    : undefined;
exports.AppDataSource = new typeorm_1.DataSource({
    type: "postgres",
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "defaultdb",
    ssl: caCert
        ? {
            rejectUnauthorized: true,
            ca: caCert,
        }
        : false,
    entities: [account_entity_1.Geo_Account, user_entity_1.Geo_User],
    migrations: ["dist/migrations/**/*.js"],
    synchronize: true, // Set to false in production
});
const initializeDatabase = async () => {
    try {
        await exports.AppDataSource.initialize();
        console.log("Database connection established");
        // Fetch system-level admin token
        const adminEmail = process.env.ADMIN_EMAIL || "clickcomgh@gmail.com";
        const adminPassword = process.env.ADMIN_PASSWORD || "CLOCK@FACIAL";
        if (!adminEmail || !adminPassword)
            throw new Error("ADMIN_EMAIL or ADMIN_PASSWORD not set in .env");
        const loginResponse = await axios_1.default.post("https://db-api-v2.akwaabasoftware.com/clients/login", {
            phone_email: adminEmail,
            password: adminPassword,
        });
        const adminToken = loginResponse.data.token;
        if (!adminToken)
            throw new Error("Failed to obtain ADMIN_TOKEN");
        console.log("Generated ADMIN_TOKEN:", adminToken);
        // Fetch admins
        const adminsResponse = await axios_1.default.get("https://db-api-v2.akwaabasoftware.com/clients/user", {
            headers: { Authorization: `Token ${adminToken}` },
        });
        console.log("Admins response:", adminsResponse.data);
        const admins = adminsResponse.data;
        // Fetch users
        const schedulesResponse = await axios_1.default.get("https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance", {
            headers: { Authorization: `Token ${adminToken}` },
            params: { selectAllSchedules: true },
        });
        console.log("Users response:", schedulesResponse.data);
        const users = schedulesResponse.data;
        const accountRepository = exports.AppDataSource.getRepository(account_entity_1.Geo_Account);
        const userRepository = exports.AppDataSource.getRepository(user_entity_1.Geo_User);
        // Create main account and admins
        for (const admin of admins) {
            let mainAccount = await accountRepository.findOne({ where: { id: `main-${admin.accountId}` } });
            if (!mainAccount) {
                mainAccount = accountRepository.create({
                    id: `main-${admin.accountId}`,
                    name: "Ministry of Education",
                    description: "Main Branch",
                    type: "main",
                    parentId: null,
                    country: "Ghana",
                    primaryAdminId: `admin-${admin.id}`,
                });
                await accountRepository.save(mainAccount);
                console.log(`Created main account for organization ${admin.accountId}`);
            }
            let adminUser = await userRepository.findOne({ where: { email: admin.email } });
            if (!adminUser) {
                adminUser = userRepository.create({
                    id: `admin-${admin.id}`,
                    firstName: admin.firstname,
                    lastName: admin.surname,
                    email: admin.email,
                    phone: admin.phone,
                    role: "admin",
                    adminType: "unlimited",
                    accountId: mainAccount.id,
                    account: mainAccount,
                });
                await userRepository.save(adminUser);
                console.log(`Created main account admin ${admin.email}`);
            }
        }
        // Migrate users
        for (const user of users) {
            const mainAccount = await accountRepository.findOne({ where: { id: `main-${user.accountId}` } });
            if (!mainAccount)
                continue;
            let existingUser = await userRepository.findOne({ where: { email: user.email } });
            if (!existingUser) {
                existingUser = userRepository.create({
                    id: `user-${user.id}`,
                    firstName: user.firstname || "Unknown",
                    lastName: user.surname || "User",
                    email: user.email,
                    phone: user.phone || "N/A",
                    role: "user",
                    accountId: mainAccount.id,
                    account: mainAccount,
                });
                await userRepository.save(existingUser);
                console.log(`Created user ${user.email} for account ${mainAccount.id}`);
            }
        }
    }
    catch (error) {
        console.error("Database initialization or migration failed:", error);
        if (axios_1.default.isAxiosError(error)) {
            console.error("Axios error details:", {
                status: error.response?.status,
                data: error.response?.data,
                headers: error.response?.headers,
            });
        }
        process.exit(1);
    }
};
exports.initializeDatabase = initializeDatabase;
