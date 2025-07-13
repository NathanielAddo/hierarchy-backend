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
  readyState: number;
  OPEN: number;
  CLOSED: number;
  CONNECTING: number;
  CLOSING: number;
}

// Add these constants at the top of the file
const WS_OPEN = 1;
const WS_CLOSED = 3;

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
  private readonly AXIOS_TIMEOUT = 10000;
  private readonly BATCH_SIZE = 50;
  private readonly MAX_RECORDS = 500;

  constructor() {
    logger.info("AccountController initialized");
  }

  private async checkPermission(user: Geo_User, targetAccountId: string): Promise<boolean> {
    try {
      if (user.role !== "admin") return false;

      const targetAccount = await this.accountRepository.findOne({
        where: { id: targetAccountId },
        relations: ["parent"],
        select: ["id", "parentId", "primaryAdminId"]
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
              select: ["id", "parentId", "primaryAdminId"]
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
        select: ["id", "parentId", "type"]
      });

      while (account?.parentId) {
        account = await this.accountRepository.findOne({
          where: { id: account.parentId },
          relations: ["parent"],
          select: ["id", "parentId", "type"]
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
        select: ["id"]
      });
      if (!parent) throw new ApiError(404, "Parent account not found");

      const primaryAdmin = await this.userRepository.findOne({
        where: { 
          id: primaryAdminId, 
          role: "admin", 
          accountId: user.accountId 
        },
        select: ["id", "accountId"]
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
        where: { 
          id: In(adminIds), 
          role: "admin", 
          accountId: user.accountId 
        },
        select: ["id", "accountId"]
      });

      for (const admin of admins) {
        if (admin.id === primaryAdminId) continue;
        admin.accountId = newAccount.id;
        admin.adminType = admin.adminType || "limited";
        await this.userRepository.save(admin);
      }

      const users = await this.userRepository.find({
        where: { 
          id: In(userIds), 
          role: "user", 
          accountId: user.accountId 
        },
        select: ["id", "accountId"]
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
        select: ["id", "name", "description", "country", "primaryAdminId"]
      });
      if (!account) throw new ApiError(404, "Account not found");

      if (data.name) account.name = sanitizeHtml(data.name);
      if (data.description) account.description = sanitizeHtml(data.description);
      if (data.country) account.country = sanitizeHtml(data.country);
      
      if (data.primaryAdminId) {
        const newAdmin = await this.userRepository.findOne({
          where: { id: data.primaryAdminId, role: "admin" },
          select: ["id"]
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
        select: ["id", "parentId", "users"]
      });
      if (!account) throw new ApiError(404, "Account not found");

      let parentAccount: Geo_Account | null = null;
      if (account.parentId) {
        parentAccount = await this.accountRepository.findOne({ 
          where: { id: account.parentId },
          select: ["id"]
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
        select: ["id"]
      });
      if (!account) throw new ApiError(404, "Account not found");

      const mainAccountId = user.account.type === "main" 
        ? user.accountId 
        : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) throw new ApiError(404, "Main account not found");

      const usersToAssign = await this.userRepository.find({
        where: { 
          id: In(data.userIds), 
          accountId: In([mainAccountId, user.accountId]) 
        },
        select: ["id", "accountId"]
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
          take: this.MAX_RECORDS
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
            "account.primaryAdminId"
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

  public async getOrganizationUsers(ws: WebSocket, user: Geo_User, token: string) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      if (user.role !== "admin") throw new ApiError(403, "Only admins can view organization users");

      const mainAccountId = user.account.type === "main" 
        ? user.accountId 
        : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) throw new ApiError(404, "Main account not found");

      const healthCheckInterval = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(healthCheckInterval);
          throw new Error("Connection closed");
        }
      }, 1000);

      try {
        // Fetch and process data
        const [admins, attendanceUsers] = await Promise.all([
          this.fetchAdmins(token),
          this.fetchAttendanceUsers(token)
        ]);

        // Process and combine data
        const responseUsers = await this.processUserData(
          admins,
          attendanceUsers,
          mainAccountId,
          user.account.name,
          user.account.type
        );

        ws.send(JSON.stringify(new ApiResponse(200, "Organization users retrieved successfully", { 
          users: responseUsers 
        })));
      } finally {
        clearInterval(healthCheckInterval);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to retrieve organization users";
      logger.error("Error fetching organization users", { error: message });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  private async fetchAdmins(token: string): Promise<OldSystemAdmin[]> {
    let admins: OldSystemAdmin[] = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get<OldSystemAdmin[]>(
        `https://db-api-v2.akwaabasoftware.com/clients/user?page=${page}&page_size=${pageSize}`,
        { 
          headers: { Authorization: `Token ${token}` },
          timeout: this.AXIOS_TIMEOUT
        }
      );

      const pageAdmins = response.data.filter(admin => admin.phone?.trim());
      admins.push(...pageAdmins);
      hasMore = pageAdmins.length === pageSize;
      page++;
    }

    return admins;
  }

  private async fetchAttendanceUsers(token: string): Promise<AttendanceRecord[]> {
    const schedulesResponse = await axios.get<Schedule[]>(
      `https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/schedule?isRecuring=both&length=${this.MAX_RECORDS}&branchId=1`,
      { 
        headers: { Authorization: `Token ${token}` },
        timeout: this.AXIOS_TIMEOUT
      }
    );

    const scheduleIds = schedulesResponse.data.map(schedule => schedule.id);
    const attendanceUsers: AttendanceRecord[] = [];

    for (let i = 0; i < scheduleIds.length; i += this.BATCH_SIZE) {
      const batch = scheduleIds.slice(i, i + this.BATCH_SIZE);
      const batchResponses = await Promise.all(
        batch.map(scheduleId =>
          axios.get<AttendanceRecord[]>(
            `https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance?scheduleId=${scheduleId}&start_date=2000-01-01&end_date=2100-01-01`,
            { 
              headers: { Authorization: `Token ${token}` },
              timeout: this.AXIOS_TIMEOUT
            }
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

    return attendanceUsers;
  }

  private async processUserData(
    admins: OldSystemAdmin[],
    attendanceUsers: AttendanceRecord[],
    mainAccountId: string,
    accountName: string,
    accountType: string
  ): Promise<UnifiedUser[]> {
    // Deduplicate users by phone
    const phoneUserMap = new Map<string, AttendanceRecord>();
    attendanceUsers
      .filter(user => user.phone?.trim())
      .forEach(user => phoneUserMap.set(user.phone!, user));

    // Create unified users
    const uniqueUsers: UnifiedUser[] = Array.from(phoneUserMap.values()).map(user => ({
      id: `user-${user.memberId}`,
      firstName: sanitizeHtml(user.firstname || "Unknown"),
      lastName: sanitizeHtml(user.surname || "User"),
      email: sanitizeHtml(user.email || `user-${user.memberId}@unknown.com`),
      phone: sanitizeHtml(user.phone || ""),
      role: "user",
      accountId: mainAccountId,
    }));

    // Sync to database in batches
    for (let i = 0; i < uniqueUsers.length; i += this.BATCH_SIZE) {
      const batch = uniqueUsers.slice(i, i + this.BATCH_SIZE);
      await this.syncUsersBatch(batch, mainAccountId);
    }

    // Get local users
    const localUsers = await this.userRepository.find({
      where: { accountId: mainAccountId },
      relations: ["account"],
      select: ["id", "firstName", "lastName", "email", "phone", "role", "adminType", "accountId"]
    });

    // Combine all users
    const allUsers = new Map<string, UnifiedUser>();

    admins.forEach(admin => {
      if (admin.phone) {
        allUsers.set(admin.phone, {
          id: `admin-${admin.id}`,
          firstName: sanitizeHtml(admin.firstname),
          lastName: sanitizeHtml(admin.surname),
          email: sanitizeHtml(admin.email),
          phone: sanitizeHtml(admin.phone),
          role: "admin",
          adminType: "unlimited",
          accountId: mainAccountId,
          accountName,
          accountType,
        });
      }
    });

    uniqueUsers.forEach(user => {
      if (user.phone) allUsers.set(user.phone, user);
    });

    localUsers.forEach(user => {
      if (user.phone) {
        allUsers.set(user.phone, {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          adminType: user.adminType,
          accountId: user.accountId,
          accountName: user.account.name,
          accountType: user.account.type,
        });
      }
    });

    return Array.from(allUsers.values());
  }

  private async syncUsersBatch(users: UnifiedUser[], accountId: string): Promise<void> {
    for (const userData of users) {
      const existingUser = await this.userRepository.findOne({ 
        where: { email: userData.email },
        select: ["id"]
      });

      if (!existingUser) {
        const account = await this.accountRepository.findOne({ 
          where: { id: accountId },
          select: ["id"]
        });

        if (account) {
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
          await this.userRepository.save(newUser);
        }
      }
    }
  }
}