import axios from "axios";
import { AppDataSource } from "../db";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";

export class AuthController {
  private userRepository = AppDataSource.getRepository(Geo_User);

  public async login(ws: any, data: { email: string; password: string }) {
    try {
      const { email, password } = data;
      console.log('Login attempt:', { email });

      // Call external API
      const loginResponse = await axios.post("https://db-api-v2.akwaabasoftware.com/clients/login", {
        email,
        password,
      });
      console.log('External API response:', loginResponse.data);

      const { token, user } = loginResponse.data;

      // Verify user in local database
      const localUser = await this.userRepository.findOne({
        where: { email: user.email, role: "admin" },
        relations: ["account"],
      });
      console.log('Local user found:', localUser ? localUser.email : 'Not found');

      if (!localUser) {
        console.log('Login failed: User not found or not an admin', { email });
        ws.send(JSON.stringify(new ApiError(401, "Only admins can log in to this system")));
        ws.close(4001, "Only admins can log in to this system");
        return;
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
      if (axios.isAxiosError(error)) {
        console.error('Axios error:', error.response?.data, error.response?.status);
        errorMessage = error.response?.data?.message || errorMessage;
      } else {
        console.error('Login error:', error);
      }
      ws.send(JSON.stringify(new ApiError(401, errorMessage)));
      ws.close(4002, errorMessage);
    }
  }

  public async logout(ws: any) {
    ws.send(JSON.stringify(new ApiResponse(200, "Logout successful")));
    ws.close(1000, "Logout successful");
  }
}