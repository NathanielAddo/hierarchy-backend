import { WebSocket } from 'ws';
import { AppDataSource } from '../db';
import { Geo_User } from '../entities/user.entity';
import { Geo_Account } from '../entities/account.entity';
import * as jwt from 'jsonwebtoken';
import { ApiResponse, ApiError } from '../utils/apiResponse';
import { compare } from 'bcrypt';

export class AuthController {
  private userRepository = AppDataSource.getRepository(Geo_User);
  private accountRepository = AppDataSource.getRepository(Geo_Account);

  async login(ws: WebSocket, data: { email: string; password: string }) {
    try {
      console.log(`Login attempt:`, { email: data.email });
      if (!data.email || !data.password) {
        console.log(`Missing credentials: email=${data.email}, password=${!!data.password}`);
        ws.send(JSON.stringify(new ApiError(400, 'Email and password are required')));
        ws.close(1008, 'Bad Request');
        return;
      }
      const localUser = await this.userRepository.findOne({
        where: { email: data.email, role: 'admin' },
        relations: ['account'],
        select: ['id', 'email', 'firstName', 'lastName', 'role', 'adminType', 'accountId', 'password'],
      });
      if (!localUser) {
        console.log(`Local user not found: ${data.email}`);
        ws.send(JSON.stringify(new ApiError(401, 'User not found or not an admin')));
        ws.close(1008, 'Unauthorized');
        return;
      }
      console.log(`Local user found: ${data.email}, accountId: ${localUser.accountId}`);
      const isPasswordValid = await compare(data.password, localUser.password);
      if (!isPasswordValid) {
        console.log(`Invalid password for: ${data.email}`);
        ws.send(JSON.stringify(new ApiError(401, 'Invalid credentials')));
        ws.close(1008, 'Unauthorized');
        return;
      }
      const account = await this.accountRepository.findOne({
        where: { id: localUser.accountId },
      });
      if (!account) {
        console.log(`Account not found for user: ${data.email}, accountId: ${localUser.accountId}`);
        ws.send(JSON.stringify(new ApiError(404, 'Account not found')));
        ws.close(1008, 'Account not found');
        return;
      }
      console.log(`Account found: id=${account.id}, name=${account.name}, description=${account.description}`);
      const token = jwt.sign(
        {
          id: localUser.id,
          email: localUser.email,
          role: localUser.role,
          adminType: localUser.adminType,
          accountId: localUser.accountId,
        },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );
      ws.send(
        JSON.stringify(
          new ApiResponse(200, 'Login successful', {
            token,
            user: {
              id: localUser.id,
              email: localUser.email,
              firstName: localUser.firstName,
              lastName: localUser.lastName,
              role: localUser.role,
              adminType: localUser.adminType,
              accountId: localUser.accountId,
              accountName: account.name,
              accountType: account.type,
              accountDescription: account.description,
            },
          })
        )
      );
      console.log(`Login successful for: ${data.email}, accountId: ${localUser.accountId}`);
    } catch (error) {
      console.error(`Login error for ${data.email}:`, error);
      ws.send(JSON.stringify(new ApiError(500, 'Internal server error')));
      ws.close(1008, 'Internal server error');
    }
  }

  async logout(ws: WebSocket) {
    console.log('Logout request received');
    ws.send(JSON.stringify(new ApiResponse(200, 'Logged out successfully')));
    ws.close(1000, 'Logged out');
  }
}