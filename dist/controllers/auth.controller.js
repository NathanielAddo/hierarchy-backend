"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const axios_1 = __importDefault(require("axios"));
const db_1 = require("../db");
const user_entity_1 = require("../entities/user.entity");
const apiResponse_1 = require("../utils/apiResponse");
class AuthController {
    constructor() {
        this.userRepository = db_1.AppDataSource.getRepository(user_entity_1.Geo_User);
    }
    async login(ws, data) {
        try {
            const { email, password } = data;
            // Call old system's login endpoint
            const loginResponse = await axios_1.default.post("https://db-api-v2.akwaabasoftware.com/clients/login", {
                email,
                password,
            });
            const { token, user } = loginResponse.data;
            // Verify user exists in new system and is an admin
            const localUser = await this.userRepository.findOne({
                where: { email: user.email, role: "admin" },
                relations: ["account"],
            });
            if (!localUser) {
                throw new apiResponse_1.ApiError(401, "Only admins can log in to this system");
            }
            ws.send(JSON.stringify(new apiResponse_1.ApiResponse(200, "Login successful", {
                token,
                user: {
                    id: localUser.id,
                    email: localUser.email,
                    firstName: localUser.firstName,
                    lastName: localUser.lastName,
                    role: localUser.role,
                    adminType: localUser.adminType,
                    accountId: localUser.accountId,
                    accountName: localUser.account.name,
                    accountType: localUser.account.type,
                },
            })));
        }
        catch (error) {
            let errorMessage = "Login failed";
            if (axios_1.default.isAxiosError(error) && error.response?.data?.message) {
                errorMessage = error.response.data.message;
            }
            ws.send(JSON.stringify(new apiResponse_1.ApiError(401, errorMessage)));
        }
    }
    async logout(ws) {
        ws.send(JSON.stringify(new apiResponse_1.ApiResponse(200, "Logout successful")));
    }
}
exports.AuthController = AuthController;
