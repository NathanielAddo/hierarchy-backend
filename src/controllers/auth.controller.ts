import axios from "axios";
import { AppDataSource } from "../db";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";

export class AuthController {
  private userRepository = AppDataSource.getRepository(Geo_User);

  public async login(ws: any, data: { email: string; password: string }) {
    try {
      const { email, password } = data;

      // Call old system's login endpoint
      const loginResponse = await axios.post("https://db-api-v2.akwaabasoftware.com/clients/login", {
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
        throw new ApiError(401, "Only admins can log in to this system");
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Login successful", {
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
          })
        )
      );
    } catch (error) {
      let errorMessage = "Login failed";
      if (axios.isAxiosError(error) && error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }
      ws.send(JSON.stringify(new ApiError(401, errorMessage)));
    }
  }

  public async logout(ws: any) {
    ws.send(JSON.stringify(new ApiResponse(200, "Logout successful")));
  }
}