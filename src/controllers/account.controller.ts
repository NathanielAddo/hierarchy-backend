// account.controller.ts
import { AppDataSource } from "../db";
import { Geo_Account } from "../entities/account.entity";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";
import winston from "winston";
import sanitizeHtml from "sanitize-html";
import { In } from "typeorm";

// Configure Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

interface WebSocket {
  send: (data: string) => void;
  readyState: number;
  OPEN: number;
}

export class AccountController {
  private accountRepository = AppDataSource.getRepository(Geo_Account);
  private userRepository = AppDataSource.getRepository(Geo_User);

  constructor() {
    logger.info("AccountController initialized");
  }

  private async checkPermission(user: Geo_User, targetAccountId: string): Promise<boolean> {
    try {
      if (user.role !== "admin") return false;

      const targetAccount = await this.accountRepository.findOne({
        where: { id: targetAccountId },
        relations: ["parent"],
        select: ["id", "parentId", "primaryAdminId"],
      });

      if (!targetAccount) return false;
      if (user.adminType === "unlimited" && user.account.type === "main") return true;

      let currentAccount: Geo_Account | null = targetAccount;
      while (currentAccount !== null) {
        if (currentAccount.id === user.accountId || currentAccount.primaryAdminId === user.id) {
          return true;
        }
        currentAccount = currentAccount.parentId
          ? await this.accountRepository.findOne({
              where: { id: currentAccount.parentId },
              relations: ["parent"],
              select: ["id", "parentId", "primaryAdminId"],
            })
          : null;
      }

      return false;
    } catch (error) {
      logger.error("Error checking permissions", { error });
      return false;
    }
  }

  private async getMainAccount(accountId: string): Promise<Geo_Account | null> {
    try {
      let account = await this.accountRepository.findOne({
        where: { id: accountId },
        relations: ["parent"],
        select: ["id", "parentId", "type"],
      });

      while (account?.parentId) {
        account = await this.accountRepository.findOne({
          where: { id: account.parentId },
          relations: ["parent"],
          select: ["id", "parentId", "type"],
        });
      }

      return account;
    } catch (error) {
      logger.error("Error fetching main account", { error });
      return null;
    }
  }

  public async createAccount(
    ws: WebSocket,
    data: {
      name: string;
      description?: string;
      type: "institutional" | "regional" | "district" | "branch" | "department";
      parentId: string;
      country: string;
      primaryAdminId: string;
      adminType: "limited" | "unlimited";
      adminIds: string[];
      userIds: string[];
    },
    user: Geo_User
  ) {
    try {
      if (ws.readyState !== ws.OPEN) return;

      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        throw new ApiError(403, "Only main account unlimited admins can create accounts");
      }

      const { name, description, type, parentId, country, primaryAdminId, adminType, adminIds, userIds } = data;

      const parent = await this.accountRepository.findOne({
        where: { id: parentId },
        select: ["id"],
      });
      if (!parent) throw new ApiError(404, "Parent account not found");

      const primaryAdmin = await this.userRepository.findOne({
        where: { id: primaryAdminId, role: "admin", accountId: user.accountId },
        select: ["id", "accountId"],
      });
      if (!primaryAdmin) throw new ApiError(404, "Primary admin not found");

      const newAccount = this.accountRepository.create({
        name: sanitizeHtml(name),
        description: description ? sanitizeHtml(description) : undefined,
        type,
        parentId,
        country: sanitizeHtml(country),
        parent,
        primaryAdminId,
      });

      await this.accountRepository.save(newAccount);

      primaryAdmin.accountId = newAccount.id;
      primaryAdmin.adminType = adminType;
      await this.userRepository.save(primaryAdmin);

      const admins = await this.userRepository.find({
        where: { id: In(adminIds), role: "admin", accountId: user.accountId },
        select: ["id", "accountId"],
      });

      for (const admin of admins) {
        if (admin.id === primaryAdminId) continue;
        admin.accountId = newAccount.id;
        admin.adminType = admin.adminType || "limited";
        await this.userRepository.save(admin);
      }

      const users = await this.userRepository.find({
        where: { id: In(userIds), role: "user", accountId: user.accountId },
        select: ["id", "accountId"],
      });

      for (const user of users) {
        user.accountId = newAccount.id;
        await this.userRepository.save(user);
      }

      const response = new ApiResponse(201, "Account created successfully", {
        account: newAccount,
        primaryAdmin,
        assignedAdmins: admins,
        assignedUsers: users,
      });
      ws.send(JSON.stringify(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      logger.error("Error creating account", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async editAccount(
    ws: WebSocket,
    data: {
      accountId: string;
      name?: string;
      description?: string;
      country?: string;
      primaryAdminId?: string;
    },
    user: Geo_User
  ) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions");
      }

      const account = await this.accountRepository.findOne({
        where: { id: data.accountId },
        select: ["id", "name", "description", "country", "primaryAdminId"],
      });
      if (!account) throw new ApiError(404, "Account not found");

      if (data.name) account.name = sanitizeHtml(data.name);
      if (data.description) account.description = sanitizeHtml(data.description);
      if (data.country) account.country = sanitizeHtml(data.country);

      if (data.primaryAdminId) {
        const newAdmin = await this.userRepository.findOne({
          where: { id: data.primaryAdminId, role: "admin" },
          select: ["id"],
        });
        if (!newAdmin) throw new ApiError(404, "New primary admin not found");
        account.primaryAdminId = data.primaryAdminId;
      }

      await this.accountRepository.save(account);
      ws.send(JSON.stringify(new ApiResponse(200, "Account updated successfully", account)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account";
      logger.error("Error editing account", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async deleteAccount(ws: WebSocket, data: { accountId: string }, user: Geo_User) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions");
      }

      const account = await this.accountRepository.findOne({
        where: { id: data.accountId },
        relations: ["users"],
        select: ["id", "parentId", "users"],
      });
      if (!account) throw new ApiError(404, "Account not found");

      let parentAccount: Geo_Account | null = null;
      if (account.parentId) {
        parentAccount = await this.accountRepository.findOne({
          where: { id: account.parentId },
          select: ["id"],
        });
      } else {
        const mainAccount = await this.getMainAccount(user.accountId);
        if (mainAccount) parentAccount = mainAccount;
      }

      if (parentAccount) {
        for (const user of account.users) {
          user.accountId = parentAccount.id;
          await this.userRepository.save(user);
        }
      }

      await this.accountRepository.delete({ id: data.accountId });
      ws.send(JSON.stringify(new ApiResponse(200, "Account deleted successfully")));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account";
      logger.error("Error deleting account", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async assignUsers(ws: WebSocket, data: { userIds: string[]; accountId: string }, user: Geo_User) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions");
      }

      const account = await this.accountRepository.findOne({
        where: { id: data.accountId },
        select: ["id"],
      });
      if (!account) throw new ApiError(404, "Account not found");

      const mainAccountId = user.account.type === "main"
        ? user.accountId
        : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) throw new ApiError(404, "Main account not found");

      const usersToAssign = await this.userRepository.find({
        where: { id: In(data.userIds), accountId: In([mainAccountId, user.accountId]) },
        select: ["id", "accountId"],
      });

      for (const userToAssign of usersToAssign) {
        userToAssign.accountId = account.id;
        await this.userRepository.save(userToAssign);
      }

      ws.send(JSON.stringify(new ApiResponse(200, "Users assigned successfully", {
        accountId: account.id,
        assignedUsers: usersToAssign,
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to assign users";
      logger.error("Error assigning users", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async getAccounts(ws: WebSocket, user: Geo_User) {
    try {
      if (ws.readyState !== ws.OPEN) return;

      let accounts;
      const startTime = Date.now();

      if (user.account.type === "main" && user.adminType === "unlimited") {
        accounts = await this.accountRepository.find({
          relations: ["parent"],
          select: ["id", "name", "type", "parentId", "country", "primaryAdminId"],
        });
      } else {
        const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
        const userAccountLevel = hierarchy.indexOf(user.account.type);

        accounts = await this.accountRepository
          .createQueryBuilder("account")
          .select([
            "account.id",
            "account.name",
            "account.type",
            "account.parentId",
            "account.country",
            "account.primaryAdminId",
          ])
          .leftJoin("account.parent", "parent")
          .addSelect(["parent.id", "parent.name"])
          .where("account.type IN (:...types)", { types: hierarchy.slice(userAccountLevel) })
          .orWhere("account.id = :userAccountId", { userAccountId: user.accountId })
          .orWhere("account.primaryAdminId = :userId", { userId: user.id })
          .getMany();
      }

      logger.debug(`Fetched accounts in ${Date.now() - startTime}ms`);
      ws.send(JSON.stringify(new ApiResponse(200, "Accounts retrieved successfully", accounts)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to retrieve accounts";
      logger.error("Error fetching accounts", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }
}