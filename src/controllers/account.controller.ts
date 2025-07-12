import { AppDataSource } from "../db";
import { Geo_Account } from "../entities/account.entity";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";
import axios from "axios";
import axiosRetry from "axios-retry";
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

// Configure axios retry
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => error.response?.status === 429 || error.code === "ECONNABORTED",
});

interface WebSocket {
  send: (data: string) => void;
}

interface OldSystemAdmin {
  id: string;
  accountId: string;
  firstname: string;
  surname: string;
  email: string;
  phone: string;
}

interface AttendanceRecord {
  memberId: string;
  firstname?: string;
  surname?: string;
  phone?: string;
  email?: string;
}

interface Schedule {
  id: string;
  [key: string]: any;
}

interface UnifiedUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: "admin" | "user";
  adminType?: "limited" | "unlimited";
  accountId: string;
  accountName?: string;
  accountType?: string;
}

export class AccountController {
  private accountRepository = AppDataSource.getRepository(Geo_Account);
  private userRepository = AppDataSource.getRepository(Geo_User);

  constructor() {
    logger.info("AccountController initialized");
  }

private async checkPermission(user: Geo_User, targetAccountId: string): Promise<boolean> {
    logger.info("Checking permissions", { userId: user.id, targetAccountId });
    try {
        if (user.role !== "admin") {
            logger.warn("Permission denied: User is not an admin", { userId: user.id });
            return false;
        }

        const targetAccount = await this.accountRepository.findOne({
            where: { id: targetAccountId },
            relations: ["parent"],
        });

        if (!targetAccount) {
            logger.error("Target account not found", { targetAccountId });
            return false;
        }

        if (user.adminType === "unlimited" && user.account.type === "main") {
            logger.info("Permission granted: User is unlimited main account admin", { userId: user.id });
            return true;
        }

        // Explicitly type currentAccount as potentially null
        let currentAccount: Geo_Account | null = targetAccount;
        while (currentAccount !== null) {
            if (currentAccount.id === user.accountId || currentAccount.primaryAdminId === user.id) {
                logger.info("Permission granted: User is assigned to or primary admin of account", {
                    userId: user.id,
                    accountId: currentAccount.id,
                });
                return true;
            }
            
            // Move to parent account if exists
            if (currentAccount.parentId) {
                currentAccount = await this.accountRepository.findOne({
                    where: { id: currentAccount.parentId },
                    relations: ["parent"],
                });
            } else {
                currentAccount = null;
            }
        }

        logger.warn("Permission denied: User not in account hierarchy", { userId: user.id, targetAccountId });
        return false;
    } catch (error) {
        logger.error("Error checking permissions", {
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
        });
        return false;
    }
}

  private async getMainAccount(accountId: string): Promise<Geo_Account | null> {
    logger.info("Fetching main account", { accountId });
    try {
      let account = await this.accountRepository.findOne({
        where: { id: accountId },
        relations: ["parent"],
      });
      while (account && account.parentId) {
        logger.debug("Traversing to parent account", { currentAccountId: account.id, parentId: account.parentId });
        account = await this.accountRepository.findOne({
          where: { id: account.parentId },
          relations: ["parent"],
        });
      }
      if (!account) {
        logger.error("Main account not found", { accountId });
      } else {
        logger.info("Main account found", { mainAccountId: account.id });
      }
      return account;
    } catch (error) {
      logger.error("Error fetching main account", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
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
    logger.info("Creating new account", { userId: user.id, data });
    try {
      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        logger.warn("Permission denied: Only main account unlimited admins can create accounts", {
          userId: user.id,
          accountType: user.account.type,
          adminType: user.adminType,
        });
        throw new ApiError(403, "Only main account admins with unlimited privileges can create accounts");
      }

      const { name, description, type, parentId, country, primaryAdminId, adminType, adminIds, userIds } = data;

      const parent = await this.accountRepository.findOne({ where: { id: parentId } });
      if (!parent) {
        logger.error("Parent account not found", { parentId });
        throw new ApiError(404, "Parent account not found");
      }

      const primaryAdmin = await this.userRepository.findOne({
        where: { id: primaryAdminId, role: "admin", accountId: user.accountId },
      });
      if (!primaryAdmin) {
        logger.error("Primary admin not found or not in organization", { primaryAdminId, accountId: user.accountId });
        throw new ApiError(404, "Primary admin not found or not in your organization");
      }

      const newAccount = this.accountRepository.create({
        name: sanitizeHtml(name),
        description: description ? sanitizeHtml(description) : undefined,
        type,
        parentId,
        country: sanitizeHtml(country),
        parent, // parent is guaranteed non-null due to the check above
        primaryAdminId,
      });

      logger.debug("Saving new account", { accountId: newAccount.id, name: newAccount.name });
      await this.accountRepository.save(newAccount);

      primaryAdmin.accountId = newAccount.id;
      primaryAdmin.account = newAccount;
      primaryAdmin.adminType = adminType;
      logger.debug("Assigning primary admin", { primaryAdminId, accountId: newAccount.id });
      await this.userRepository.save(primaryAdmin);

      const admins: Geo_User[] = await this.userRepository.find({
        where: { id: In(adminIds), role: "admin", accountId: user.accountId },
      });
      for (const admin of admins) {
        if (admin.id === primaryAdminId) continue;
        admin.accountId = newAccount.id;
        admin.account = newAccount;
        admin.adminType = admin.adminType || "limited";
        logger.debug("Assigning admin to account", { adminId: admin.id, accountId: newAccount.id });
        await this.userRepository.save(admin);
      }

      const users: Geo_User[] = await this.userRepository.find({
        where: { id: In(userIds), role: "user", accountId: user.accountId },
      });
      for (const user of users) {
        user.accountId = newAccount.id;
        user.account = newAccount;
        logger.debug("Assigning user to account", { userId: user.id, accountId: newAccount.id });
        await this.userRepository.save(user);
      }

      const response = new ApiResponse(201, "Account created successfully", {
        account: newAccount,
        primaryAdmin,
        assignedAdmins: admins,
        assignedUsers: users,
      });
      logger.info("Account created successfully", { accountId: newAccount.id, name: newAccount.name });
      ws.send(JSON.stringify(response));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      logger.error("Error creating account", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        userId: user.id,
        data,
      });
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
    logger.info("Editing account", { userId: user.id, accountId: data.accountId });
    try {
      if (!(await this.checkPermission(user, data.accountId))) {
        logger.warn("Permission denied for editing account", { userId: user.id, accountId: data.accountId });
        throw new ApiError(403, "Insufficient permissions to edit this account");
      }

      const account = await this.accountRepository.findOne({ where: { id: data.accountId } });
      if (!account) {
        logger.error("Account not found", { accountId: data.accountId });
        throw new ApiError(404, "Account not found");
      }

      if (data.name) account.name = sanitizeHtml(data.name);
      if (data.description) account.description = sanitizeHtml(data.description);
      if (data.country) account.country = sanitizeHtml(data.country);
      if (data.primaryAdminId) {
        const newAdmin = await this.userRepository.findOne({
          where: { id: data.primaryAdminId, role: "admin" },
        });
        if (!newAdmin) {
          logger.error("New primary admin not found", { primaryAdminId: data.primaryAdminId });
          throw new ApiError(404, "New primary admin not found");
        }
        account.primaryAdminId = data.primaryAdminId;
        logger.debug("Updating primary admin", { accountId: account.id, newPrimaryAdminId: data.primaryAdminId });
      }

      logger.debug("Saving updated account", { accountId: account.id });
      await this.accountRepository.save(account);

      const response = new ApiResponse(200, "Account updated successfully", account);
      logger.info("Account updated successfully", { accountId: account.id });
      ws.send(JSON.stringify(response));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update account";
      logger.error("Error editing account", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        userId: user.id,
        data,
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

public async deleteAccount(ws: WebSocket, data: { accountId: string }, user: Geo_User) {
    logger.info("Deleting account", { userId: user.id, accountId: data.accountId });
    try {
        if (!(await this.checkPermission(user, data.accountId))) {
            logger.warn("Permission denied for deleting account", { userId: user.id, accountId: data.accountId });
            throw new ApiError(403, "Insufficient permissions to delete this account");
        }

        const account = await this.accountRepository.findOne({
            where: { id: data.accountId },
            relations: ["users", "parent"],
        });
        if (!account) {
            logger.error("Account not found", { accountId: data.accountId });
            throw new ApiError(404, "Account not found");
        }

        // Get parent account or main account
        let parentAccount: Geo_Account | null = null;
        if (account.parentId) {
            parentAccount = await this.accountRepository.findOne({ where: { id: account.parentId } });
        } else {
            const mainAccount = await this.getMainAccount(user.accountId);
            if (mainAccount) {
                parentAccount = mainAccount;
            }
        }

        if (parentAccount) {
            for (const user of account.users) {
                user.accountId = parentAccount.id;
                user.account = parentAccount;
                logger.debug("Reassigning user to parent account", {
                    userId: user.id,
                    fromAccountId: account.id,
                    toAccountId: parentAccount.id,
                });
                await this.userRepository.save(user);
            }
        } else {
            logger.warn("No parent account found, users will not be reassigned", { accountId: account.id });
        }

        logger.debug("Deleting account", { accountId: account.id });
        await this.accountRepository.delete({ id: data.accountId });

        const response = new ApiResponse(200, "Account deleted successfully");
        logger.info("Account deleted successfully", { accountId: data.accountId });
        ws.send(JSON.stringify(response));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to delete account";
        logger.error("Error deleting account", {
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
            userId: user.id,
            accountId: data.accountId,
        });
        ws.send(JSON.stringify(new ApiError(500, message)));
    }
}

  public async assignUsers(ws: WebSocket, data: { userIds: string[]; accountId: string }, user: Geo_User) {
    logger.info("Assigning users to account", { userId: user.id, accountId: data.accountId, userIds: data.userIds });
    try {
      if (!(await this.checkPermission(user, data.accountId))) {
        logger.warn("Permission denied for assigning users", { userId: user.id, accountId: data.accountId });
        throw new ApiError(403, "Insufficient permissions to assign users to this account");
      }

      const account = await this.accountRepository.findOne({ where: { id: data.accountId } });
      if (!account) {
        logger.error("Account not found", { accountId: data.accountId });
        throw new ApiError(404, "Account not found");
      }

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) {
        logger.error("Main account not found", { userAccountId: user.accountId });
        throw new ApiError(404, "Main account not found");
      }

      const usersToAssign: Geo_User[] = await this.userRepository.find({
        where: { id: In(data.userIds), accountId: In([mainAccountId, user.accountId]) },
      });

      for (const userToAssign of usersToAssign) {
        userToAssign.accountId = account.id;
        userToAssign.account = account;
        logger.debug("Assigning user to account", { userId: userToAssign.id, accountId: account.id });
        await this.userRepository.save(userToAssign);
      }

      const response = new ApiResponse(200, "Users assigned successfully", {
        accountId: account.id,
        assignedUsers: usersToAssign,
      });
      logger.info("Users assigned successfully", { accountId: account.id, assignedUserCount: usersToAssign.length });
      ws.send(JSON.stringify(response));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to assign users";
      logger.error("Error assigning users", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        userId: user.id,
        data,
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async getAccounts(ws: WebSocket, user: Geo_User) {
    logger.info("Fetching accounts", { userId: user.id });
    try {
      let accounts;
      if (user.account.type === "main" && user.adminType === "unlimited") {
        accounts = await this.accountRepository.find({ relations: ["parent", "users"] });
        logger.debug("Fetched all accounts for unlimited main admin", { accountCount: accounts.length });
      } else {
        const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
        const userAccountLevel = hierarchy.indexOf(user.account.type);
        accounts = await this.accountRepository
          .createQueryBuilder("account")
          .leftJoinAndSelect("account.parent", "parent")
          .leftJoinAndSelect("account.users", "users")
          .where("account.type IN (:...types)", { types: hierarchy.slice(userAccountLevel) })
          .orWhere("account.id = :userAccountId", { userAccountId: user.accountId })
          .orWhere("account.primaryAdminId = :userId", { userId: user.id })
          .getMany();
        logger.debug("Fetched accounts for limited admin", { accountCount: accounts.length, userAccountType: user.account.type });
      }

      logger.info("Preparing accounts response", {
        count: accounts.length,
        sampleAccount: accounts.length > 0 ? {
          id: accounts[0].id,
          name: accounts[0].name,
          type: accounts[0].type,
          usersCount: accounts[0].users?.length || 0,
        } : null,
      });

      const response = new ApiResponse(200, "Accounts retrieved successfully", accounts);
      logger.info("Sending accounts response", {
        statusCode: response.status,
        message: response.message,
        dataCount: Array.isArray(response.data) ? response.data.length : 1,
      });

      ws.send(JSON.stringify(response));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve accounts";
      logger.error("Error fetching accounts", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        userId: user.id,
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async getOrganizationUsers(ws: WebSocket, user: Geo_User, token: string) {
    logger.info("Fetching organization users", { userId: user.id, tokenLength: token.length });
    try {
      if (user.role !== "admin") {
        logger.warn("Permission denied: User is not an admin", { userId: user.id });
        throw new ApiError(403, "Only admins can view organization users");
      }

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) {
        logger.error("Main account not found", { userAccountId: user.accountId });
        throw new ApiError(404, "Main account not found");
      }
      logger.debug("Main account ID", { mainAccountId });

      // Validate token
      logger.debug("Validating external API token");
      try {
        const tokenResponse = await axios.get("https://db-api-v2.akwaabasoftware.com/auth/verify", {
          headers: { Authorization: `Token ${token}` },
        });
        if (!tokenResponse.data.valid) {
          logger.error("Invalid external API token");
          throw new ApiError(401, "Invalid external API token");
        }
      } catch (error) {
        logger.error("Token validation failed", {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw new ApiError(401, "Invalid external API token");
      }

      // Fetch admins with pagination
      logger.debug("Fetching admins from external API");
      let admins: OldSystemAdmin[] = [];
      let page = 1;
      const pageSize = 100;
      while (true) {
        const adminsResponse = await axios.get<OldSystemAdmin[]>(
          `https://db-api-v2.akwaabasoftware.com/clients/user?page=${page}&limit=${pageSize}`,
          { headers: { Authorization: `Token ${token}` } }
        );
        const pageAdmins = adminsResponse.data.filter(
          (admin) => admin.phone && admin.phone.trim() !== ""
        );
        admins.push(...pageAdmins);
        logger.debug("Fetched admin page", { page, count: pageAdmins.length });
        if (pageAdmins.length < pageSize) break;
        page++;
      }
      logger.info("Received admins", { count: admins.length });

      // Fetch users from attendance endpoint
      logger.debug("Fetching schedules for user data");
      const schedulesResponse = await axios.get<Schedule[]>(
        "https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/schedules",
        { headers: { Authorization: `Token ${token}` } }
      );
      logger.info("Found schedules", { count: schedulesResponse.data.length });

      const scheduleIds = schedulesResponse.data.map(schedule => schedule.id);
      const attendanceUsers: AttendanceRecord[] = [];
      const batchSize = 5;
      for (let i = 0; i < scheduleIds.length; i += batchSize) {
        const batch = scheduleIds.slice(i, i + batchSize);
        logger.debug("Processing attendance batch", { batchSize, batchIndex: i });
        const batchResponses = await Promise.all(
          batch.map(scheduleId =>
            axios.get<AttendanceRecord[]>(
              `https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance?scheduleId=${scheduleId}&start_date=2000-01-01&end_date=2100-01-01`,
              { headers: { Authorization: `Token ${token}` } }
            )
          )
        );
        batchResponses.forEach(response => {
          response.data.forEach(record => {
            if (record.memberId) {
              attendanceUsers.push({
                memberId: record.memberId,
                firstname: record.firstname,
                surname: record.surname,
                phone: record.phone,
                email: record.email,
              });
            }
          });
        });
      }
      logger.info("Processed attendance records", { count: attendanceUsers.length });

      // Deduplicate by email or memberId
      const phoneUserMap = new Map<string, AttendanceRecord>();
      attendanceUsers
        .filter(user => user.phone && user.phone.trim() !== "")
        .forEach(user => {
          const key = user.phone!;
          if (key) phoneUserMap.set(key, user);
        });

      // Sync users to local database
      const uniqueUsers: UnifiedUser[] = Array.from(phoneUserMap.values()).map(user => ({
        id: `user-${user.memberId}`,
        firstName: sanitizeHtml(user.firstname || "Unknown"),
        lastName: sanitizeHtml(user.surname || "User"),
        email: sanitizeHtml(user.email || `user-${user.memberId}@unknown.com`),
        phone: sanitizeHtml(user.phone || ""),
        role: "user",
        accountId: mainAccountId,
      }));
      logger.info("Unique users after deduplication", { count: uniqueUsers.length });

      for (const userData of uniqueUsers) {
        const existingUser = await this.userRepository.findOne({ where: { email: userData.email } });
        if (!existingUser) {
          const account = await this.accountRepository.findOne({ where: { id: userData.accountId } });
          if (!account) {
            logger.error("Account not found for user sync", { accountId: userData.accountId });
            continue;
          }
          const newUser = this.userRepository.create({
            id: userData.id,
            firstName: userData.firstName,
            lastName: userData.lastName,
            email: userData.email,
            phone: userData.phone,
            role: userData.role,
            accountId: userData.accountId,
            account,
          });
          logger.debug("Saving new user to database", { userId: newUser.id, email: newUser.email });
          await this.userRepository.save(newUser);
        }
      }

      // Fetch local users
      logger.debug("Fetching local users");
      const localUsers = await this.userRepository.find({
        where: { accountId: mainAccountId },
        relations: ["account"],
      });
      logger.info("Local users found", { count: localUsers.length });

      const subAccounts = await this.accountRepository.find({
        where: { parentId: user.accountId },
        relations: ["users"],
      });
      logger.info("Sub-accounts found", { count: subAccounts.length });

      const subAccountUsers = await this.userRepository.find({
        where: subAccounts.map(acc => ({ accountId: acc.id })),
        relations: ["account"],
      });
      logger.info("Sub-account users found", { count: subAccountUsers.length });

      const allUsers = new Map<string, UnifiedUser>();

      admins.forEach(admin => {
        if (admin.phone) {
          allUsers.set(admin.phone, {
            id: `admin-${admin.id}`,
            firstName: sanitizeHtml(admin.firstname),
            lastName: sanitizeHtml(admin.surname),
            email: sanitizeHtml(admin.email),
            phone: sanitizeHtml(admin.phone),
            role: "admin" as const,
            adminType: "unlimited" as const,
            accountId: mainAccountId,
            accountName: user.account.name,
            accountType: user.account.type,
          });
        }
      });

      uniqueUsers.forEach(user => {
        if (user.phone) {
          allUsers.set(user.phone, user);
        }
      });

      const responseUsers: UnifiedUser[] = Array.from(allUsers.values());

      logger.info("Total users prepared for response", {
        count: responseUsers.length,
        sampleUser: responseUsers.length > 0 ? {
          id: responseUsers[0].id,
          name: `${responseUsers[0].firstName} ${responseUsers[0].lastName}`,
          role: responseUsers[0].role,
          accountName: responseUsers[0].accountName,
        } : null,
      });

      const response = new ApiResponse(200, "Organization users retrieved successfully", { users: responseUsers });
      ws.send(JSON.stringify(response));
      logger.info("Organization users response sent successfully");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve organization users";
      logger.error("Error fetching organization users", {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        userId: user.id,
        tokenValid: !!token,
        tokenLength: token?.length,
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }
}