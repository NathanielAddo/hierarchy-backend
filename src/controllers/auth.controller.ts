import { AppDataSource } from "../db";
import { User } from "../entities/user.entity";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { ApiResponse, ApiError } from "../utils/apiResponse";

export class AuthController {
  private userRepository = AppDataSource.getRepository(User);

  public async login(ws: any, data: { email: string; password: string }) {
    try {
      const { email, password } = data;
      const user = await this.userRepository.findOne({
        where: { email },
        relations: ["account"],
      });

      if (!user || !(await bcrypt.compare(password, user.password))) {
        throw new ApiError(401, "Invalid credentials");
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, accountId: user.accountId },
        process.env.JWT_SECRET || "secret",
        { expiresIn: "1h" }
      );

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Login successful", {
            token,
            user: {
              id: user.id,
              email: user.email,
              firstName: user.firstName,
              lastName: user.lastName,
              role: user.role,
              adminType: user.adminType,
              accountId: user.accountId,
              accountName: user.account.name,
              accountType: user.account.type,
            },
          })
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async logout(ws: any) {
    ws.send(JSON.stringify(new ApiResponse(200, "Logout successful")));
  }
}