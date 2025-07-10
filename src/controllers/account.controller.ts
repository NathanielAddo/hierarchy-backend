import { AppDataSource } from "../db";
import { Account } from "../entities/account.entity";
import { User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";
import * as bcrypt from "bcrypt";

interface WebSocket {
  send(message: string): void;
  subscribe(topic: string): void;
  close(): void;
}

export class AccountController {
  private accountRepository = AppDataSource.getRepository(Account);
  private userRepository = AppDataSource.getRepository(User);

  private async checkPermission(user: User, targetAccountId: string): Promise<boolean> {
    if (user.role !== "admin") return false;
    if (user.adminType === "unlimited") return true;

    if (!user.account || !user.account.type) return false; // Check for user.account and type

    const targetAccount = await this.accountRepository.findOne({
      where: { id: targetAccountId },
      relations: ["parent"],
    });

    if (!targetAccount || !targetAccount.type) return false; // Check for targetAccount and type

    const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
    const userAccountLevel = hierarchy.indexOf(user.account.type);
    const targetAccountLevel = hierarchy.indexOf(targetAccount.type);

    return userAccountLevel <= targetAccountLevel || targetAccount.parentId === user.accountId;
  }

  public async createAccount(
    ws: WebSocket,
    data: {
      name: string;
      type: "institutional" | "regional" | "district" | "branch" | "department";
      parentId: string;
      country: string;
      adminIds: string[];
      userIds: string[];
    },
    user: User
  ) {
    try {
      if (!user.account || !user.account.type || (user.account.type !== "main" && user.adminType !== "unlimited")) {
        throw new ApiError(403, "Only main account admins can create accounts");
      }

      const { name, type, parentId, country, adminIds, userIds } = data;

      const parent = await this.accountRepository.findOne({ where: { id: parentId } });
      if (!parent) throw new ApiError(404, "Parent account not found");

      const newAccount = this.accountRepository.create({
        name,
        type,
        parentId,
        country,
        parent,
      });

      await this.accountRepository.save(newAccount);

      if (!newAccount.id) throw new ApiError(500, "Failed to generate account ID");

      // Assign admins and users
      const admins = await this.userRepository.findByIds(adminIds);
      const users = await this.userRepository.findByIds(userIds);

      for (const admin of admins) {
        if (admin.role !== "admin") continue;
        admin.accountId = newAccount.id;
        admin.account = newAccount;
        await this.userRepository.save(admin);
      }

      for (const user of users) {
        if (user.role !== "user") continue;
        user.accountId = newAccount.id;
        user.account = newAccount;
        await this.userRepository.save(user);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(201, "Account created successfully", {
            account: newAccount,
            assignedAdmins: admins,
            assignedUsers: users,
          })
        )
      );
    } catch (error: any) {
      ws.send(JSON.stringify(new ApiError(500, error.message || "Failed to create account")));
    }
  }

  public async createUser(
    ws: WebSocket,
    data: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      password: string;
      role: "admin" | "user";
      adminType?: "limited" | "unlimited";
      accountId: string;
    },
    user: User
  ) {
    try {
      if (!user.account || !user.account.type || (user.account.type !== "main" && user.adminType !== "unlimited")) {
        throw new ApiError(403, "Only main account admins can create users");
      }

      const { firstName, lastName, email, phone, password, role, adminType, accountId } = data;

      const account = await this.accountRepository.findOne({ where: { id: accountId } });
      if (!account) throw new ApiError(404, "Account not found");

      const existingUser = await this.userRepository.findOne({ where: { email } });
      if (existingUser) throw new ApiError(409, "Email already exists");

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = this.userRepository.create({
        firstName,
        lastName,
        email,
        phone,
        password: hashedPassword,
        role,
        adminType: role === "admin" ? adminType : undefined,
        accountId,
        account,
      });

      await this.userRepository.save(newUser);

      ws.send(
        JSON.stringify(
          new ApiResponse(201, `${role.charAt(0).toUpperCase() + role.slice(1)} created successfully`, newUser)
        )
      );
    } catch (error: any) {
      ws.send(JSON.stringify(new ApiError(500, error.message || "Failed to create user")));
    }
  }

  public async assignUsers(ws: WebSocket, data: { userIds: string[]; accountId: string }, user: User) {
    try {
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions to assign users to this account");
      }

      const account = await this.accountRepository.findOne({ where: { id: data.accountId } });
      if (!account || !account.id) throw new ApiError(404, "Account not found");

      const usersToAssign = await this.userRepository.findByIds(data.userIds);
      for (const user of usersToAssign) {
        user.accountId = account.id;
        user.account = account;
        await this.userRepository.save(user);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Users assigned successfully", {
            accountId: account.id,
            assignedUsers: usersToAssign,
          })
        )
      );
    } catch (error: any) {
      ws.send(JSON.stringify(new ApiError(500, error.message || "Failed to assign users")));
    }
  }

  public async getAccounts(ws: WebSocket, user: User) {
    try {
      if (!user.account || !user.account.type) throw new ApiError(400, "User account not found");

      let accounts;
      if (user.account.type === "main" || user.adminType === "unlimited") {
        accounts = await this.accountRepository.find({ relations: ["parent", "users"] });
      } else {
        const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
        const userAccountLevel = hierarchy.indexOf(user.account.type);
        accounts = await this.accountRepository
          .createQueryBuilder("account")
          .leftJoinAndSelect("account.parent", "parent")
          .leftJoinAndSelect("account.users", "users")
          .where("account.type IN (:...types)", {
            types: hierarchy.slice(userAccountLevel),
          })
          .orWhere("account.id = :userAccountId", { userAccountId: user.accountId })
          .getMany();
      }

      ws.send(JSON.stringify(new ApiResponse(200, "Accounts retrieved successfully", accounts)));
    } catch (error: any) {
      ws.send(JSON.stringify(new ApiError(500, error.message || "Failed to retrieve accounts")));
    }
  }
}