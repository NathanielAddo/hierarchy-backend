import { AppDataSource } from "../db";
import { Geo_Account } from "../entities/account.entity";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";
import axios from "axios";

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

interface OldSystemUser {
  id: string;
  accountId?: string;
  firstname?: string;
  surname: string;
  email: string;
  phone?: string;
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

  private async checkPermission(user: Geo_User, targetAccountId: string): Promise<boolean> {
    if (user.role !== "admin") return false;

    const targetAccount = await this.accountRepository.findOne({
      where: { id: targetAccountId },
      relations: ["parent"],
    });

    if (!targetAccount) return false;

    if (user.adminType === "unlimited" && user.account.type === "main") return true;

    const isPrimaryAdmin = targetAccount.primaryAdminId === user.id;
    const isAssignedToAccount = user.accountId === targetAccountId;

    if (!isPrimaryAdmin && !isAssignedToAccount) return false;

    if (user.adminType === "limited") return false;

    const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
    const userAccountLevel = hierarchy.indexOf(user.account.type);
    const targetAccountLevel = hierarchy.indexOf(targetAccount.type);

    return userAccountLevel <= targetAccountLevel || targetAccount.parentId === user.accountId;
  }

  public async createAccount(ws: WebSocket, data: {
    name: string;
    description?: string;
    type: "institutional" | "regional" | "district" | "branch" | "department";
    parentId: string;
    country: string;
    primaryAdminId: string;
    adminType: "limited" | "unlimited";
    adminIds: string[];
    userIds: string[];
  }, user: Geo_User) {
    try {
      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        throw new ApiError(403, "Only main account admins with unlimited privileges can create accounts");
      }

      const { name, description, type, parentId, country, primaryAdminId, adminType, adminIds, userIds } = data;

      const parent = await this.accountRepository.findOne({ where: { id: parentId } });
      if (!parent) throw new ApiError(404, "Parent account not found");

      const primaryAdmin = await this.userRepository.findOne({ 
        where: { id: primaryAdminId, role: "admin", accountId: user.accountId } 
      });
      if (!primaryAdmin) throw new ApiError(404, "Primary admin not found or not in your organization");

      const newAccount = this.accountRepository.create({
        name,
        description,
        type,
        parentId,
        country,
        parent,
        primaryAdminId,
      });

      await this.accountRepository.save(newAccount);

      primaryAdmin.accountId = newAccount.id;
      primaryAdmin.account = newAccount;
      primaryAdmin.adminType = adminType;
      await this.userRepository.save(primaryAdmin);

      const admins: Geo_User[] = await this.userRepository.findByIds(adminIds);
      const users: Geo_User[] = await this.userRepository.findByIds(userIds);

      for (const admin of admins) {
        if (admin.role !== "admin" || admin.accountId !== user.accountId || admin.id === primaryAdminId) continue;
        admin.accountId = newAccount.id;
        admin.account = newAccount;
        admin.adminType = admin.adminType || "limited";
        await this.userRepository.save(admin);
      }

      for (const user of users) {
        if (user.role !== "user" || user.accountId !== user.accountId) continue;
        user.accountId = newAccount.id;
        user.account = newAccount;
        await this.userRepository.save(user);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(201, "Account created successfully", {
            account: newAccount,
            primaryAdmin,
            assignedAdmins: admins,
            assignedUsers: users,
          })
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async createUser(ws: WebSocket, data: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    role: "admin" | "user";
    adminType?: "limited" | "unlimited";
    accountId: string;
  }, user: Geo_User) {
    try {
      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        throw new ApiError(403, "Only main account admins with unlimited privileges can create users");
      }

      const { firstName, lastName, email, phone, role, adminType, accountId } = data;

      const account = await this.accountRepository.findOne({ where: { id: accountId } });
      if (!account) throw new ApiError(404, "Account not found");

      const existingUser = await this.userRepository.findOne({ where: { email } });
      if (existingUser) throw new ApiError(409, "Email already exists");

      const newUser = this.userRepository.create({
        firstName,
        lastName,
        email,
        phone,
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create user";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async assignUsers(ws: WebSocket, data: { userIds: string[]; accountId: string }, user: Geo_User) {
    try {
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions to assign users to this account");
      }

      const account = await this.accountRepository.findOne({ where: { id: data.accountId } });
      if (!account) throw new ApiError(404, "Account not found");

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      const usersToAssign: Geo_User[] = await this.userRepository.findByIds(data.userIds);

      for (const userToAssign of usersToAssign) {
        if (userToAssign.accountId !== mainAccountId && userToAssign.accountId !== user.accountId) continue;
        userToAssign.accountId = account.id;
        userToAssign.account = account;
        await this.userRepository.save(userToAssign);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Users assigned successfully", {
            accountId: account.id,
            assignedUsers: usersToAssign,
          })
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to assign users";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  private async getMainAccount(accountId: string): Promise<Geo_Account | null> {
    let account = await this.accountRepository.findOne({ where: { id: accountId }, relations: ["parent"] });
    while (account && account.parentId) {
      account = await this.accountRepository.findOne({ where: { id: account.parentId }, relations: ["parent"] });
    }
    return account;
  }

 public async getAccounts(ws: WebSocket, user: Geo_User) {
    try {
      let accounts;
      if (user.account.type === "main" && user.adminType === "unlimited") {
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
          .orWhere("account.primaryAdminId = :userId", { userId: user.id })
          .getMany();
      }

      console.log('Preparing accounts response:', { 
        count: accounts.length,
        sampleAccount: accounts.length > 0 ? {
          id: accounts[0].id,
          name: accounts[0].name,
          type: accounts[0].type,
          usersCount: accounts[0].users?.length || 0
        } : null
      });

      const response = new ApiResponse(200, "Accounts retrieved successfully", accounts);
      console.log('Sending accounts response:', {
        statusCode: response.status,
        message: response.message,
        dataCount: Array.isArray(response.data) ? response.data.length : 1
      });

      ws.send(JSON.stringify(response));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve accounts";
      console.error('Error in getAccounts:', {
        error: message,
        stack: error instanceof Error ? error.stack : undefined
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async getOrganizationUsers(ws: WebSocket, user: Geo_User, token: string) {
    try {
      if (user.role !== "admin") {
        throw new ApiError(403, "Only admins can view organization users");
      }

      console.log('Starting getOrganizationUsers for user:', {
        userId: user.id,
        accountType: user.account.type,
        adminType: user.adminType
      });

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) throw new ApiError(404, "Main account not found");

      console.log('Main account ID:', mainAccountId);

      // 1. Fetch Admins from external API
      console.log('Fetching admins from external API...');
      const adminsResponse = await axios.get<OldSystemAdmin[]>(
        "https://db-api-v2.akwaabasoftware.com/clients/user",
        { headers: { Authorization: `Token ${token}` } }
      );
      const admins = adminsResponse.data.filter(admin => `main-${admin.accountId}` === mainAccountId);
      console.log('Received admins:', { count: admins.length });

      // 2. Fetch Users from Attendance Endpoint
      console.log('Fetching schedules for user data...');
      const schedulesResponse = await axios.get<Schedule[]>(
        "https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/schedules",
        { headers: { Authorization: `Token ${token}` } }
      );
      console.log('Found schedules:', { count: schedulesResponse.data.length });

      const scheduleIds = schedulesResponse.data.map(schedule => schedule.id);
      const attendanceUsers: AttendanceRecord[] = [];

      // Batch process schedules
      console.log('Processing attendance records in batches...');
      const batchSize = 5;
      for (let i = 0; i < scheduleIds.length; i += batchSize) {
        const batch = scheduleIds.slice(i, i + batchSize);
        const batchResponses = await Promise.all(
          batch.map(scheduleId => 
            axios.get<AttendanceRecord[]>(
              `https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance?scheduleId=${scheduleId}`,
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
      console.log('Processed attendance records:', { count: attendanceUsers.length });

      // Deduplicate users by phone number
      const phoneUserMap = new Map<string, AttendanceRecord>();
      attendanceUsers
        .filter(user => user.phone)
        .forEach(user => {
          if (user.phone) {
            phoneUserMap.set(user.phone, user);
          }
        });

      const uniqueUsers: UnifiedUser[] = Array.from(phoneUserMap.values())
        .map(user => ({
          id: `user-${user.memberId}`,
          firstName: user.firstname || "Unknown",
          lastName: user.surname || "User",
          email: user.email || "",
          phone: user.phone || "",
          role: "user" as const,
          accountId: mainAccountId,
        }));
      console.log('Unique users after deduplication:', { count: uniqueUsers.length });

      // 3. Get local users
      console.log('Fetching local users...');
      const mainAccount = await this.accountRepository.findOne({ where: { id: mainAccountId } });
      if (!mainAccount) throw new ApiError(404, "Main account not found");

      const localUsers = await this.userRepository.find({
        where: { accountId: mainAccountId },
        relations: ["account"],
      });
      console.log('Local users found:', { count: localUsers.length });

      const subAccounts = await this.accountRepository.find({
        where: { parentId: user.accountId },
        relations: ["users"],
      });
      console.log('Sub-accounts found:', { count: subAccounts.length });

      const subAccountUsers = await this.userRepository.find({
        where: subAccounts.map(acc => ({ accountId: acc.id })),
        relations: ["account"],
      });
      console.log('Sub-account users found:', { count: subAccountUsers.length });

      // Create unified response
      const responseUsers: UnifiedUser[] = [
        ...admins.map(admin => ({
          id: `admin-${admin.id}`,
          firstName: admin.firstname,
          lastName: admin.surname,
          email: admin.email,
          phone: admin.phone,
          role: "admin" as const,
          adminType: "unlimited" as const,
          accountId: mainAccountId,
          accountName: user.account.name,
          accountType: user.account.type,
        })),
        ...uniqueUsers,
        ...localUsers.map(user => ({
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role as "admin" | "user",
          adminType: user.adminType as "limited" | "unlimited" | undefined,
          accountId: user.accountId,
          accountName: user.account.name,
          accountType: user.account.type,
        })),
        ...subAccountUsers.map(user => ({
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role as "admin" | "user",
          adminType: user.adminType as "limited" | "unlimited" | undefined,
          accountId: user.accountId,
          accountName: user.account.name,
          accountType: user.account.type,
        }))
      ];

      console.log('Total users prepared for response:', { count: responseUsers.length });
      console.log('Sample user data:', responseUsers.length > 0 ? {
        id: responseUsers[0].id,
        name: `${responseUsers[0].firstName} ${responseUsers[0].lastName}`,
        role: responseUsers[0].role,
        accountName: responseUsers[0].accountName
      } : null);

      const response = new ApiResponse(200, "Organization users retrieved successfully", {
        users: responseUsers,
      });
      ws.send(JSON.stringify(response));
      console.log('Organization users response sent successfully');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve organization users";
      console.error('Error in getOrganizationUsers:', {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        tokenValid: !!token,
        tokenLength: token?.length
      });
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }
}